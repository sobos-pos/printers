"""
Wastage logging and analytics (F-23).

Every wastage entry deducts from stock and creates an audit trail.
Feeds into food waste analytics (F-62).
"""

from decimal import Decimal

from django.db import transaction
from django.db.models import Sum, Count, Q

from inventory.models import (
    Batch,
    BatchStatus,
    MovementType,
    StockLevel,
    WastageLog,
    WastageReason,
)
from inventory.services import stock_service


def log_wastage(
    *,
    ingredient_id,
    location_id,
    quantity,
    reason,
    batch_id=None,
    notes='',
    logged_by=None,
):
    """Log wastage and deduct from stock.

    If ``batch_id`` is provided, the waste is attributed to that specific
    batch and the batch's remaining quantity is decremented.
    """
    quantity = Decimal(str(quantity))
    if quantity <= Decimal('0'):
        raise ValueError('Wastage quantity must be positive.')

    with transaction.atomic():
        # Get current cost for estimation
        stock = stock_service.get_or_create_stock_level(ingredient_id, location_id)
        estimated_cost = quantity * stock.unit_cost

        # Handle batch-specific wastage
        batch = None
        if batch_id:
            batch = (
                Batch.objects
                .select_for_update()
                .get(id=batch_id, ingredient_id=ingredient_id, location_id=location_id)
            )
            if batch.remaining_quantity < quantity:
                raise ValueError(
                    f'Batch {batch.batch_number} has only '
                    f'{batch.remaining_quantity} remaining, cannot waste {quantity}.'
                )
            batch.remaining_quantity -= quantity
            if batch.remaining_quantity <= Decimal('0'):
                batch.status = BatchStatus.WASTED
            batch.save(update_fields=['remaining_quantity', 'status', 'updated_at'])

        # Create wastage record
        wastage = WastageLog.objects.create(
            ingredient_id=ingredient_id,
            location_id=location_id,
            batch=batch,
            quantity=quantity,
            estimated_cost=estimated_cost,
            reason=reason,
            notes=notes,
            logged_by=logged_by,
        )

        # Deduct from stock
        stock_service.deduct_stock(
            ingredient_id=ingredient_id,
            location_id=location_id,
            quantity=quantity,
            movement_type=MovementType.WASTAGE,
            reference_type='wastage',
            reference_id=wastage.id,
            performed_by=logged_by,
        )

    return wastage


def get_wastage_summary(*, location_id, date_from=None, date_to=None):
    """Aggregated wastage report: totals and breakdown by reason.

    Returns::

        {
            'total_quantity': Decimal,
            'total_cost': Decimal,
            'count': int,
            'by_reason': [
                {'reason': 'expired', 'reason_display': 'Expired',
                 'total_quantity': Decimal, 'total_cost': Decimal, 'count': int},
                ...
            ]
        }
    """
    qs = WastageLog.objects.filter(location_id=location_id)
    if date_from:
        qs = qs.filter(created_at__gte=date_from)
    if date_to:
        qs = qs.filter(created_at__lte=date_to)

    totals = qs.aggregate(
        total_quantity=Sum('quantity'),
        total_cost=Sum('estimated_cost'),
        count=Count('id'),
    )

    by_reason = (
        qs.values('reason')
        .annotate(
            total_quantity=Sum('quantity'),
            total_cost=Sum('estimated_cost'),
            count=Count('id'),
        )
        .order_by('-total_cost')
    )

    # Add display names
    reason_display = dict(WastageReason.choices)
    by_reason_list = [
        {
            'reason': entry['reason'],
            'reason_display': reason_display.get(entry['reason'], entry['reason']),
            'total_quantity': entry['total_quantity'] or Decimal('0'),
            'total_cost': entry['total_cost'] or Decimal('0'),
            'count': entry['count'],
        }
        for entry in by_reason
    ]

    return {
        'total_quantity': totals['total_quantity'] or Decimal('0'),
        'total_cost': totals['total_cost'] or Decimal('0'),
        'count': totals['count'] or 0,
        'by_reason': by_reason_list,
    }
