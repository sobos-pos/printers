"""
Recipe management and ingredient deduction for orders (F-15, F-16).

Handles recipe cost calculation and automatic ingredient deduction when
orders are confirmed.
"""

import logging
from decimal import Decimal

from django.db import transaction

from inventory.models import (
    MovementType,
    Recipe,
    RecipeIngredient,
    StockLevel,
)
from inventory.services import stock_service

logger = logging.getLogger('inventory')


# ---------------------------------------------------------------------------
# Unit conversion
# ---------------------------------------------------------------------------

def _convert_to_base_unit(quantity, from_unit, to_unit):
    """Convert quantity between units using conversion factors.

    Both units must share the same base unit (or one must be the base).
    Returns the quantity in ``to_unit``.
    """
    if from_unit.id == to_unit.id:
        return quantity

    # Determine base for each unit
    from_base = from_unit.base_unit or from_unit
    to_base = to_unit.base_unit or to_unit

    if from_base.id != to_base.id and from_unit.id != to_base.id and to_unit.id != from_base.id:
        raise ValueError(
            f'Cannot convert between {from_unit.short_name} and '
            f'{to_unit.short_name} — they have different base units.'
        )

    # Convert from_unit → base → to_unit
    from_factor = from_unit.conversion_factor if from_unit.base_unit else Decimal('1')
    to_factor = to_unit.conversion_factor if to_unit.base_unit else Decimal('1')

    # quantity in from_unit → quantity in base unit → quantity in to_unit
    base_quantity = quantity * from_factor
    return base_quantity / to_factor


# ---------------------------------------------------------------------------
# Recipe lookup
# ---------------------------------------------------------------------------

def _get_recipe_for_item(menu_item_id, variant_id=None):
    """Find the recipe for a menu item/variant.

    Preference: variant-specific recipe > item-level recipe (variant=None).
    Returns None if no recipe is configured.
    """
    if variant_id:
        recipe = (
            Recipe.objects
            .filter(menu_item_id=menu_item_id, variant_id=variant_id)
            .prefetch_related('ingredients__ingredient__unit', 'ingredients__unit')
            .first()
        )
        if recipe:
            return recipe

    # Fall back to item-level recipe
    return (
        Recipe.objects
        .filter(menu_item_id=menu_item_id, variant__isnull=True)
        .prefetch_related('ingredients__ingredient__unit', 'ingredients__unit')
        .first()
    )


# ---------------------------------------------------------------------------
# Cost calculation (F-16)
# ---------------------------------------------------------------------------

def calculate_recipe_cost(recipe_id, location_id):
    """Calculate total ingredient cost for one serving of a recipe.

    Returns::

        {
            'total_cost': Decimal,
            'ingredient_costs': [
                {
                    'ingredient_id': UUID,
                    'ingredient_name': str,
                    'quantity': Decimal,
                    'unit': str,
                    'unit_cost': Decimal,
                    'line_cost': Decimal,
                },
            ]
        }
    """
    recipe_ingredients = (
        RecipeIngredient.objects
        .filter(recipe_id=recipe_id)
        .select_related('ingredient', 'ingredient__unit', 'unit')
    )

    total_cost = Decimal('0')
    ingredient_costs = []

    for ri in recipe_ingredients:
        try:
            stock = StockLevel.objects.get(
                ingredient_id=ri.ingredient_id,
                location_id=location_id,
            )
            unit_cost = stock.unit_cost
        except StockLevel.DoesNotExist:
            unit_cost = Decimal('0')

        # Convert recipe unit to ingredient's tracking unit for costing
        qty_in_tracking_unit = _convert_to_base_unit(
            ri.quantity, ri.unit, ri.ingredient.unit,
        )
        line_cost = qty_in_tracking_unit * unit_cost

        ingredient_costs.append({
            'ingredient_id': ri.ingredient_id,
            'ingredient_name': ri.ingredient.name,
            'quantity': ri.quantity,
            'unit': ri.unit.short_name,
            'unit_cost': unit_cost,
            'line_cost': line_cost,
        })
        total_cost += line_cost

    return {
        'total_cost': total_cost,
        'ingredient_costs': ingredient_costs,
    }


# ---------------------------------------------------------------------------
# Order deduction (F-20 — auto-deduct on order confirmation)
# ---------------------------------------------------------------------------

def deduct_ingredients_for_order(*, order_id, location_id, performed_by=None):
    """Deduct ingredients for all items in an order.

    For each OrderItem:
    1. Find the Recipe for (menu_item, variant)
    2. Calculate total_qty = recipe_qty × order_item.quantity
    3. Convert units if needed
    4. Deduct via stock_service

    The entire operation is atomic — if any ingredient has insufficient
    stock, nothing is deducted.
    """
    from orders.models import OrderItem

    order_items = (
        OrderItem.objects
        .filter(order_id=order_id)
        .select_related('menu_item', 'variant')
    )

    if not order_items.exists():
        return

    with transaction.atomic():
        deductions = []

        # Phase 1: Calculate all deductions (validate before mutating)
        for order_item in order_items:
            recipe = _get_recipe_for_item(
                order_item.menu_item_id,
                order_item.variant_id,
            )
            if not recipe:
                logger.debug(
                    'No recipe for %s (variant=%s), skipping deduction.',
                    order_item.menu_item.name,
                    order_item.variant_id,
                )
                continue

            for ri in recipe.ingredients.select_related('ingredient__unit', 'unit'):
                qty_per_serving = _convert_to_base_unit(
                    ri.quantity, ri.unit, ri.ingredient.unit,
                )
                total_qty = qty_per_serving * order_item.quantity
                deductions.append({
                    'ingredient_id': ri.ingredient_id,
                    'ingredient_name': ri.ingredient.name,
                    'quantity': total_qty,
                })

        # Phase 2: Validate all stock levels
        shortages = []
        for d in deductions:
            try:
                stock = StockLevel.objects.get(
                    ingredient_id=d['ingredient_id'],
                    location_id=location_id,
                )
                if stock.quantity < d['quantity']:
                    shortages.append(
                        f'{d["ingredient_name"]}: need {d["quantity"]}, '
                        f'have {stock.quantity}'
                    )
            except StockLevel.DoesNotExist:
                shortages.append(
                    f'{d["ingredient_name"]}: no stock level configured'
                )

        if shortages:
            raise ValueError(
                f'Insufficient stock for order {order_id}: '
                + '; '.join(shortages)
            )

        # Phase 3: Execute deductions
        for d in deductions:
            stock_service.deduct_stock(
                ingredient_id=d['ingredient_id'],
                location_id=location_id,
                quantity=d['quantity'],
                movement_type=MovementType.ORDER_DEDUCTION,
                reference_type='order',
                reference_id=order_id,
                performed_by=performed_by,
            )

    logger.info(
        'Deducted ingredients for order %s: %d items processed.',
        order_id, len(deductions),
    )


# ---------------------------------------------------------------------------
# Availability check (F-17)
# ---------------------------------------------------------------------------

def check_ingredient_availability(menu_item_id, variant_id=None, location_id=None, quantity=1):
    """Check if enough ingredients are available for N servings of a dish.

    Returns::

        {
            'available': bool,
            'shortages': [
                {
                    'ingredient_name': str,
                    'required': Decimal,
                    'available': Decimal,
                    'unit': str,
                },
            ]
        }
    """
    recipe = _get_recipe_for_item(menu_item_id, variant_id)
    if not recipe:
        return {'available': True, 'shortages': []}

    shortages = []
    for ri in recipe.ingredients.select_related('ingredient__unit', 'unit'):
        qty_per_serving = _convert_to_base_unit(
            ri.quantity, ri.unit, ri.ingredient.unit,
        )
        total_required = qty_per_serving * quantity

        try:
            stock = StockLevel.objects.get(
                ingredient_id=ri.ingredient_id,
                location_id=location_id,
            )
            available_qty = stock.quantity
        except StockLevel.DoesNotExist:
            available_qty = Decimal('0')

        if available_qty < total_required:
            shortages.append({
                'ingredient_name': ri.ingredient.name,
                'required': total_required,
                'available': available_qty,
                'unit': ri.ingredient.unit.short_name,
            })

    return {
        'available': len(shortages) == 0,
        'shortages': shortages,
    }
