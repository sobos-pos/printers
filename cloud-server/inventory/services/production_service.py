"""Bulk production of prepared items (semi-finished goods).

A production run consumes raw ingredients once (per the prepared item's
component bill of materials) and yields prepared stock tracked in its own
balance + FIFO batches. Menu orders then consume the prepared stock per plate.

All mutations are atomic and append to the PreparedStockMovement ledger so the
prepared balance is always reconstructable.
"""

import logging
import secrets
from decimal import Decimal

from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from inventory.models import (
    BatchStatus,
    MovementType,
    PreparedItem,
    PreparedItemComponent,
    PreparedMovementType,
    PreparedStockLevel,
    PreparedStockMovement,
    ProductionBatch,
    StockLevel,
)
from inventory.services import stock_service
from inventory.services.units import convert_units

logger = logging.getLogger('inventory')

_ORDER_REFERENCE_TYPE = 'order'
_PRODUCTION_REFERENCE_TYPE = 'production'


# ---------------------------------------------------------------------------
# Prepared-stock balance + ledger
# ---------------------------------------------------------------------------

def _generate_batch_number(produced_at):
    return f'PROD-{produced_at:%Y%m%d}-{secrets.token_hex(3).upper()}'


def _recalculate_prepared_cost(stock, added_qty, added_unit_cost):
    """Weighted-average cost for prepared stock on a positive movement."""
    current_value = stock.quantity * stock.unit_cost
    new_value = added_qty * added_unit_cost
    total_qty = stock.quantity + added_qty
    if total_qty > Decimal('0'):
        stock.unit_cost = (current_value + new_value) / total_qty
    else:
        stock.unit_cost = added_unit_cost


def _write_prepared_movement(
    *, stock, movement_type, delta, unit_cost=None, production_batch=None,
    reference_type='', reference_id=None, performed_by=None, notes='',
):
    quantity_before = stock.quantity
    PreparedStockMovement.objects.create(
        prepared_item_id=stock.prepared_item_id,
        location_id=stock.location_id,
        movement_type=movement_type,
        quantity=delta,
        quantity_before=quantity_before,
        quantity_after=quantity_before + delta,
        unit_cost=unit_cost if unit_cost is not None else stock.unit_cost,
        production_batch=production_batch,
        reference_type=reference_type,
        reference_id=reference_id,
        performed_by=performed_by,
        notes=notes,
    )


def _consume_fifo_production_batches(prepared_item_id, location_id, quantity):
    """Consume prepared stock from oldest non-expired batches first."""
    batches = (
        ProductionBatch.objects
        .filter(
            prepared_item_id=prepared_item_id,
            location_id=location_id,
            status=BatchStatus.ACTIVE,
            remaining_quantity__gt=Decimal('0'),
        )
        .select_for_update()
        .order_by('produced_at')
    )
    remaining = quantity
    for batch in batches:
        if remaining <= Decimal('0'):
            break
        take = min(batch.remaining_quantity, remaining)
        batch.remaining_quantity -= take
        if batch.remaining_quantity <= Decimal('0'):
            batch.status = BatchStatus.CONSUMED
        batch.save(update_fields=['remaining_quantity', 'status', 'updated_at'])
        remaining -= take
    return remaining


def _restore_fifo_production_batches(prepared_item_id, location_id, quantity):
    """Refill prepared batches oldest-first, undoing a prior consumption."""
    batches = (
        ProductionBatch.objects
        .filter(
            prepared_item_id=prepared_item_id,
            location_id=location_id,
            status__in=[BatchStatus.ACTIVE, BatchStatus.CONSUMED],
            remaining_quantity__lt=F('produced_quantity'),
        )
        .select_for_update()
        .order_by('produced_at')
    )
    remaining = quantity
    for batch in batches:
        if remaining <= Decimal('0'):
            break
        capacity = batch.produced_quantity - batch.remaining_quantity
        restore = min(capacity, remaining)
        batch.remaining_quantity += restore
        if batch.status == BatchStatus.CONSUMED and batch.remaining_quantity > Decimal('0'):
            batch.status = BatchStatus.ACTIVE
        batch.save(update_fields=['remaining_quantity', 'status', 'updated_at'])
        remaining -= restore
    return remaining


# ---------------------------------------------------------------------------
# Production (raw → prepared)
# ---------------------------------------------------------------------------

def produce(
    *, prepared_item_id, location_id, quantity,
    produced_at=None, batch_number='', performed_by=None, notes='',
):
    """Run one production batch: deduct raw components, yield prepared stock.

    Deducts ``component.quantity × quantity`` of each raw ingredient (raising
    :class:`InsufficientStockError` if any is short, atomically), creates a
    ProductionBatch (with expiry from the item's shelf life), and adds the
    yield to the prepared stock balance at weighted-average cost.
    """
    from inventory.services.recipe_service import InsufficientStockError

    if quantity <= Decimal('0'):
        raise ValueError('Production quantity must be positive.')

    produced_at = produced_at or timezone.now()

    with transaction.atomic():
        prepared = PreparedItem.objects.select_related('unit').get(id=prepared_item_id)
        components = list(
            PreparedItemComponent.objects
            .filter(prepared_item_id=prepared_item_id)
            .select_related('ingredient__unit', 'unit')
        )
        if not components:
            raise ValueError(
                f'Prepared item "{prepared.name}" has no component recipe.'
            )

        # Resolve raw requirements in each ingredient's tracking unit.
        requirements = []
        for c in components:
            req_qty = convert_units(c.quantity, c.unit, c.ingredient.unit) * quantity
            requirements.append((c.ingredient, req_qty))

        # Shortage pre-check — nothing is deducted unless every line is covered.
        shortages = []
        for ingredient, req_qty in requirements:
            stock = StockLevel.objects.filter(
                ingredient_id=ingredient.id, location_id=location_id,
            ).first()
            available = stock.quantity if stock else Decimal('0')
            if available < req_qty:
                shortages.append(
                    f'{ingredient.name}: need {req_qty}, have {available}'
                )
        if shortages:
            raise InsufficientStockError(shortages)

        # Deduct raw and tally cost for the batch.
        batch_number = batch_number or _generate_batch_number(produced_at)
        batch = ProductionBatch.objects.create(
            prepared_item_id=prepared_item_id,
            location_id=location_id,
            batch_number=batch_number,
            produced_quantity=quantity,
            remaining_quantity=quantity,
            produced_at=produced_at,
            expiry_at=(
                produced_at + timezone.timedelta(hours=prepared.shelf_life_hours)
                if prepared.shelf_life_hours
                else None
            ),
            produced_by=performed_by,
            notes=notes,
        )

        total_raw_cost = Decimal('0')
        for ingredient, req_qty in requirements:
            _, movement = stock_service.deduct_stock(
                ingredient_id=ingredient.id,
                location_id=location_id,
                quantity=req_qty,
                movement_type=MovementType.PRODUCTION_CONSUMPTION,
                reference_type=_PRODUCTION_REFERENCE_TYPE,
                reference_id=batch.id,
                performed_by=performed_by,
            )
            total_raw_cost += req_qty * (movement.unit_cost or Decimal('0'))

        batch.unit_cost = (
            total_raw_cost / quantity if quantity else Decimal('0')
        )
        batch.save(update_fields=['unit_cost', 'updated_at'])

        # Add yield to the prepared balance (weighted-average cost) + ledger.
        stock, _created = (
            PreparedStockLevel.objects
            .select_for_update()
            .get_or_create(
                prepared_item_id=prepared_item_id, location_id=location_id,
            )
        )
        _recalculate_prepared_cost(stock, quantity, batch.unit_cost)
        _write_prepared_movement(
            stock=stock,
            movement_type=PreparedMovementType.PRODUCTION_OUTPUT,
            delta=quantity,
            unit_cost=batch.unit_cost,
            production_batch=batch,
            reference_type=_PRODUCTION_REFERENCE_TYPE,
            reference_id=batch.id,
            performed_by=performed_by,
        )
        stock.quantity += quantity
        stock.save(update_fields=['quantity', 'unit_cost', 'updated_at'])

    logger.info(
        'Produced %s %s of %s (batch %s).',
        quantity, prepared.unit.short_name, prepared.name, batch.batch_number,
    )
    return batch


# ---------------------------------------------------------------------------
# Prepared-stock consumption (order deduction) + reversal
# ---------------------------------------------------------------------------

def deduct_prepared_stock(
    *, prepared_item_id, location_id, quantity, movement_type,
    reference_type='', reference_id=None, performed_by=None,
):
    """Deduct prepared stock (FIFO over production batches). Atomic + logged."""
    from inventory.services.recipe_service import InsufficientStockError

    if quantity <= Decimal('0'):
        raise ValueError('Deduction quantity must be positive.')

    with transaction.atomic():
        stock = (
            PreparedStockLevel.objects
            .select_for_update()
            .select_related('prepared_item')
            .filter(prepared_item_id=prepared_item_id, location_id=location_id)
            .first()
        )
        if stock is None or stock.quantity < quantity:
            available = stock.quantity if stock else Decimal('0')
            name = stock.prepared_item.name if stock else str(prepared_item_id)
            raise InsufficientStockError(
                [f'{name}: need {quantity}, have {available}']
            )

        _consume_fifo_production_batches(prepared_item_id, location_id, quantity)
        _write_prepared_movement(
            stock=stock,
            movement_type=movement_type,
            delta=-quantity,
            reference_type=reference_type,
            reference_id=reference_id,
            performed_by=performed_by,
        )
        stock.quantity -= quantity
        stock.save(update_fields=['quantity', 'updated_at'])
    return stock


def reverse_prepared_for_order(*, order_id, location_id, performed_by=None):
    """Return prepared stock deducted for an order (idempotent)."""
    deductions = PreparedStockMovement.objects.filter(
        reference_type=_ORDER_REFERENCE_TYPE,
        reference_id=order_id,
        movement_type=PreparedMovementType.ORDER_DEDUCTION,
    )
    if not deductions.exists():
        return
    already_reversed = PreparedStockMovement.objects.filter(
        reference_type=_ORDER_REFERENCE_TYPE,
        reference_id=order_id,
        movement_type=PreparedMovementType.ORDER_REVERSAL,
    ).exists()
    if already_reversed:
        return

    per_item = deductions.values('prepared_item_id').annotate(total=Sum('quantity'))
    with transaction.atomic():
        for row in per_item:
            qty = -row['total']
            if qty <= Decimal('0'):
                continue
            stock = (
                PreparedStockLevel.objects
                .select_for_update()
                .get(prepared_item_id=row['prepared_item_id'], location_id=location_id)
            )
            _restore_fifo_production_batches(
                row['prepared_item_id'], location_id, qty,
            )
            _write_prepared_movement(
                stock=stock,
                movement_type=PreparedMovementType.ORDER_REVERSAL,
                delta=qty,
                reference_type=_ORDER_REFERENCE_TYPE,
                reference_id=order_id,
                performed_by=performed_by,
            )
            stock.quantity += qty
            stock.save(update_fields=['quantity', 'updated_at'])


# ---------------------------------------------------------------------------
# Expiry (shelf-life enforcement)
# ---------------------------------------------------------------------------

def expire_production_batches(*, location_id=None, now=None):
    """Mark expired ACTIVE batches WASTED and write off their remaining stock.

    Intended to be run periodically (e.g. a Celery beat task). Returns the
    number of batches expired.
    """
    now = now or timezone.now()
    qs = ProductionBatch.objects.filter(
        status=BatchStatus.ACTIVE,
        expiry_at__isnull=False,
        expiry_at__lte=now,
        remaining_quantity__gt=Decimal('0'),
    )
    if location_id:
        qs = qs.filter(location_id=location_id)

    expired = 0
    with transaction.atomic():
        for batch in qs.select_for_update():
            stock = (
                PreparedStockLevel.objects
                .select_for_update()
                .get(
                    prepared_item_id=batch.prepared_item_id,
                    location_id=batch.location_id,
                )
            )
            write_off = batch.remaining_quantity
            _write_prepared_movement(
                stock=stock,
                movement_type=PreparedMovementType.EXPIRY,
                delta=-write_off,
                production_batch=batch,
                reference_type='production',
                reference_id=batch.id,
            )
            stock.quantity = max(Decimal('0'), stock.quantity - write_off)
            stock.save(update_fields=['quantity', 'updated_at'])

            batch.remaining_quantity = Decimal('0')
            batch.status = BatchStatus.EXPIRED
            batch.save(update_fields=['remaining_quantity', 'status', 'updated_at'])
            expired += 1

    if expired:
        logger.info('Expired %d production batch(es).', expired)
    return expired
