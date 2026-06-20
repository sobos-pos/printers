"""
Stock-level operations: adjustments, deductions, replenishments, queries.

Every function that mutates stock acquires a ``select_for_update()`` lock on
the StockLevel row and records a StockMovement for auditability.
"""

from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from inventory.models import (
    BatchStatus,
    Batch,
    CostMethod,
    MovementType,
    StockLevel,
    StockMovement,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_or_create_stock_level(ingredient_id, location_id):
    """Return the StockLevel for (ingredient, location), creating if needed."""
    stock, _created = StockLevel.objects.get_or_create(
        ingredient_id=ingredient_id,
        location_id=location_id,
    )
    return stock


def _recalculate_cost(stock, received_qty, received_unit_price):
    """Update ``stock.unit_cost`` using the configured cost method."""
    if stock.cost_method == CostMethod.LATEST_PRICE:
        stock.unit_cost = received_unit_price
    else:  # weighted_average
        current_value = stock.quantity * stock.unit_cost
        new_value = received_qty * received_unit_price
        total_qty = stock.quantity + received_qty
        if total_qty > Decimal('0'):
            stock.unit_cost = (current_value + new_value) / total_qty
        else:
            stock.unit_cost = received_unit_price


def _deduct_fifo_batches(ingredient_id, location_id, quantity):
    """Deduct from the oldest active batches (FIFO). Returns remaining qty."""
    batches = (
        Batch.objects
        .filter(
            ingredient_id=ingredient_id,
            location_id=location_id,
            status=BatchStatus.ACTIVE,
            remaining_quantity__gt=Decimal('0'),
        )
        .select_for_update()
        .order_by('created_at')
    )
    remaining = quantity
    for batch in batches:
        if remaining <= Decimal('0'):
            break
        deduct = min(batch.remaining_quantity, remaining)
        batch.remaining_quantity -= deduct
        if batch.remaining_quantity <= Decimal('0'):
            batch.status = BatchStatus.CONSUMED
        batch.save(update_fields=['remaining_quantity', 'status', 'updated_at'])
        remaining -= deduct
    return remaining


# ---------------------------------------------------------------------------
# Stock mutations (all atomic, all logged)
# ---------------------------------------------------------------------------

def adjust_stock(
    *,
    ingredient_id,
    location_id,
    new_quantity,
    reason,
    notes='',
    performed_by=None,
):
    """Manual stock adjustment — sets quantity to an absolute value.

    Used for physical stock counts and corrections (F-20).
    """
    with transaction.atomic():
        stock = (
            StockLevel.objects
            .select_for_update()
            .select_related('ingredient')
            .get(ingredient_id=ingredient_id, location_id=location_id)
        )
        quantity_before = stock.quantity
        delta = new_quantity - quantity_before

        stock.quantity = new_quantity
        stock.save(update_fields=['quantity', 'updated_at'])

        movement = StockMovement.objects.create(
            ingredient_id=ingredient_id,
            location_id=location_id,
            movement_type=MovementType.PHYSICAL_COUNT,
            quantity=delta,
            quantity_before=quantity_before,
            quantity_after=new_quantity,
            unit_cost=stock.unit_cost,
            reference_type='adjustment',
            reason=reason,
            notes=notes,
            performed_by=performed_by,
        )
    return stock, movement


def record_opening_stock(
    *,
    ingredient_id,
    location_id,
    quantity,
    unit_cost=Decimal('0'),
    performed_by=None,
):
    """Set initial stock for a new ingredient at a location."""
    with transaction.atomic():
        stock, created = StockLevel.objects.select_for_update().get_or_create(
            ingredient_id=ingredient_id,
            location_id=location_id,
        )
        if not created and stock.quantity > Decimal('0'):
            raise ValueError(
                f'Stock already exists with quantity {stock.quantity}. '
                'Use adjust_stock for corrections.'
            )
        quantity_before = stock.quantity
        stock.quantity = quantity
        stock.unit_cost = unit_cost
        stock.save(update_fields=['quantity', 'unit_cost', 'updated_at'])

        StockMovement.objects.create(
            ingredient_id=ingredient_id,
            location_id=location_id,
            movement_type=MovementType.OPENING_STOCK,
            quantity=quantity,
            quantity_before=quantity_before,
            quantity_after=quantity,
            unit_cost=unit_cost,
            performed_by=performed_by,
        )
    return stock


def deduct_stock(
    *,
    ingredient_id,
    location_id,
    quantity,
    movement_type,
    reference_type='',
    reference_id=None,
    notes='',
    performed_by=None,
):
    """Deduct stock (internal helper). Validates sufficient stock.

    Also deducts from FIFO batches if any exist.
    ``quantity`` should be a positive Decimal — it will be stored as negative
    in StockMovement.
    """
    if quantity <= Decimal('0'):
        raise ValueError('Deduction quantity must be positive.')

    with transaction.atomic():
        stock = (
            StockLevel.objects
            .select_for_update()
            .get(ingredient_id=ingredient_id, location_id=location_id)
        )
        if stock.quantity < quantity:
            raise ValueError(
                f'Insufficient stock for {stock.ingredient.name}: '
                f'available={stock.quantity}, requested={quantity}'
            )
        quantity_before = stock.quantity
        stock.quantity -= quantity
        stock.save(update_fields=['quantity', 'updated_at'])

        # FIFO batch deduction (best-effort — batches may not exist)
        _deduct_fifo_batches(ingredient_id, location_id, quantity)

        movement = StockMovement.objects.create(
            ingredient_id=ingredient_id,
            location_id=location_id,
            movement_type=movement_type,
            quantity=-quantity,  # Negative = stock out
            quantity_before=quantity_before,
            quantity_after=stock.quantity,
            unit_cost=stock.unit_cost,
            reference_type=reference_type,
            reference_id=reference_id,
            notes=notes,
            performed_by=performed_by,
        )
    return stock, movement


def replenish_stock(
    *,
    ingredient_id,
    location_id,
    quantity,
    unit_cost,
    movement_type,
    reference_type='',
    reference_id=None,
    batch=None,
    notes='',
    performed_by=None,
):
    """Add stock (internal helper). Recalculates unit cost.

    Called by purchase receipt and transfer-in flows.
    """
    if quantity <= Decimal('0'):
        raise ValueError('Replenishment quantity must be positive.')

    with transaction.atomic():
        stock, _created = (
            StockLevel.objects
            .select_for_update()
            .get_or_create(
                ingredient_id=ingredient_id,
                location_id=location_id,
            )
        )
        quantity_before = stock.quantity
        _recalculate_cost(stock, quantity, unit_cost)
        stock.quantity += quantity

        update_fields = ['quantity', 'unit_cost', 'updated_at']
        if movement_type == MovementType.PURCHASE_RECEIPT:
            stock.last_restocked_at = timezone.now()
            update_fields.append('last_restocked_at')

        stock.save(update_fields=update_fields)

        movement = StockMovement.objects.create(
            ingredient_id=ingredient_id,
            location_id=location_id,
            movement_type=movement_type,
            quantity=quantity,  # Positive = stock in
            quantity_before=quantity_before,
            quantity_after=stock.quantity,
            unit_cost=unit_cost,
            reference_type=reference_type,
            reference_id=reference_id,
            batch=batch,
            notes=notes,
            performed_by=performed_by,
        )
    return stock, movement


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

def get_low_stock_items(location_id):
    """Return StockLevels at or below their low_stock_threshold."""
    return (
        StockLevel.objects
        .filter(
            location_id=location_id,
            low_stock_threshold__isnull=False,
            quantity__lte=models_F('low_stock_threshold'),
        )
        .select_related('ingredient', 'ingredient__unit', 'ingredient__category')
        .order_by('quantity')
    )


def get_stock_movements(
    *,
    ingredient_id=None,
    location_id=None,
    movement_type=None,
    date_from=None,
    date_to=None,
):
    """Filtered queryset of StockMovement for audit/reporting."""
    qs = StockMovement.objects.select_related(
        'ingredient', 'ingredient__unit', 'performed_by',
    )
    if ingredient_id:
        qs = qs.filter(ingredient_id=ingredient_id)
    if location_id:
        qs = qs.filter(location_id=location_id)
    if movement_type:
        qs = qs.filter(movement_type=movement_type)
    if date_from:
        qs = qs.filter(created_at__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__lte=date_to)
    return qs.order_by('-created_at')


# Needed for the F() expression in get_low_stock_items
from django.db.models import F as models_F  # noqa: E402
