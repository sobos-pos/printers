"""
Inter-location stock transfer workflow (F-26).

Lifecycle: Requested → Approved → Dispatched → Received
                     → Rejected
                     → Cancelled

On approval, stock is deducted from the sending location.
On receipt, stock is added to the receiving location.
"""

from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from inventory.models import (
    MovementType,
    StockTransfer,
    StockTransferItem,
    TransferStatus,
)
from inventory.services import stock_service


# ---------------------------------------------------------------------------
# Valid state transitions
# ---------------------------------------------------------------------------

_VALID_TRANSITIONS = {
    TransferStatus.REQUESTED: [
        TransferStatus.APPROVED,
        TransferStatus.REJECTED,
        TransferStatus.CANCELLED,
    ],
    TransferStatus.APPROVED: [
        TransferStatus.DISPATCHED,
        TransferStatus.CANCELLED,
    ],
    TransferStatus.DISPATCHED: [
        TransferStatus.RECEIVED,
    ],
    TransferStatus.REJECTED: [],
    TransferStatus.RECEIVED: [],
    TransferStatus.CANCELLED: [],
}


def _validate_transition(current, target):
    allowed = _VALID_TRANSITIONS.get(current, [])
    if target not in allowed:
        raise ValueError(
            f'Cannot transition transfer from "{current}" to "{target}". '
            f'Allowed: {[s.label for s in allowed] or "none (terminal state)"}.'
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def generate_transfer_number():
    """Auto-generate: TRF-{YYYYMMDD}-{seq:04d}."""
    today = timezone.now().date()
    date_str = today.strftime('%Y%m%d')
    count = StockTransfer.objects.filter(
        transfer_number__startswith=f'TRF-{date_str}',
    ).count()
    return f'TRF-{date_str}-{count + 1:04d}'


# ---------------------------------------------------------------------------
# Transfer lifecycle
# ---------------------------------------------------------------------------

def create_transfer(
    *,
    from_location_id,
    to_location_id,
    items_data,
    reason='',
    requested_by=None,
):
    """Create a stock transfer request.

    ``items_data``: list of dicts with keys: ingredient_id, requested_quantity
    """
    if str(from_location_id) == str(to_location_id):
        raise ValueError('Cannot transfer stock to the same location.')
    if not items_data:
        raise ValueError('Transfer must have at least one item.')

    with transaction.atomic():
        transfer = StockTransfer.objects.create(
            transfer_number=generate_transfer_number(),
            from_location_id=from_location_id,
            to_location_id=to_location_id,
            reason=reason,
            requested_by=requested_by,
        )

        for item_data in items_data:
            StockTransferItem.objects.create(
                transfer=transfer,
                ingredient_id=item_data['ingredient_id'],
                requested_quantity=item_data['requested_quantity'],
            )

    return transfer


def approve_transfer(transfer_id, *, approved_quantities=None, approved_by=None):
    """Approve a transfer request. Deducts stock from sending location.

    ``approved_quantities``: optional dict {item_id: quantity} for partial approval.
    If not provided, full requested quantities are approved.
    """
    with transaction.atomic():
        transfer = (
            StockTransfer.objects
            .select_for_update()
            .get(id=transfer_id)
        )
        _validate_transition(transfer.status, TransferStatus.APPROVED)

        items = transfer.items.select_related('ingredient')
        for item in items:
            qty = (
                Decimal(str(approved_quantities[str(item.id)]))
                if approved_quantities and str(item.id) in approved_quantities
                else item.requested_quantity
            )
            if qty > item.requested_quantity:
                raise ValueError(
                    f'Approved quantity ({qty}) exceeds requested '
                    f'({item.requested_quantity}) for {item.ingredient.name}.'
                )
            item.approved_quantity = qty
            item.save(update_fields=['approved_quantity', 'updated_at'])

            # Deduct from sender
            stock_service.deduct_stock(
                ingredient_id=item.ingredient_id,
                location_id=transfer.from_location_id,
                quantity=qty,
                movement_type=MovementType.TRANSFER_OUT,
                reference_type='transfer',
                reference_id=transfer.id,
            )

        transfer.status = TransferStatus.APPROVED
        transfer.approved_by = approved_by
        transfer.approved_at = timezone.now()
        transfer.save(update_fields=[
            'status', 'approved_by', 'approved_at', 'updated_at',
        ])

    return transfer


def reject_transfer(transfer_id, *, rejection_reason='', rejected_by=None):
    """Reject a transfer request. No stock impact."""
    with transaction.atomic():
        transfer = (
            StockTransfer.objects
            .select_for_update()
            .get(id=transfer_id)
        )
        _validate_transition(transfer.status, TransferStatus.REJECTED)

        transfer.status = TransferStatus.REJECTED
        transfer.rejection_reason = rejection_reason
        transfer.save(update_fields=['status', 'rejection_reason', 'updated_at'])

    return transfer


def dispatch_transfer(transfer_id):
    """Mark transfer as dispatched (in transit)."""
    with transaction.atomic():
        transfer = (
            StockTransfer.objects
            .select_for_update()
            .get(id=transfer_id)
        )
        _validate_transition(transfer.status, TransferStatus.DISPATCHED)

        transfer.status = TransferStatus.DISPATCHED
        transfer.save(update_fields=['status', 'updated_at'])

    return transfer


def receive_transfer(transfer_id, *, received_quantities=None, received_by=None):
    """Receive transfer at destination. Adds stock to receiving location.

    ``received_quantities``: optional dict {item_id: quantity}.
    If not provided, approved quantities are used.
    """
    with transaction.atomic():
        transfer = (
            StockTransfer.objects
            .select_for_update()
            .select_related('from_location', 'to_location')
            .get(id=transfer_id)
        )
        _validate_transition(transfer.status, TransferStatus.RECEIVED)

        items = transfer.items.select_related('ingredient')
        for item in items:
            qty = (
                Decimal(str(received_quantities[str(item.id)]))
                if received_quantities and str(item.id) in received_quantities
                else item.approved_quantity
            )
            if qty is None:
                raise ValueError(
                    f'No approved quantity for {item.ingredient.name}. '
                    'Transfer must be approved before receiving.'
                )
            item.received_quantity = qty
            item.save(update_fields=['received_quantity', 'updated_at'])

            # Get sender's unit cost for the ingredient
            sender_stock = stock_service.get_or_create_stock_level(
                item.ingredient_id, transfer.from_location_id,
            )

            # Replenish at receiver
            stock_service.replenish_stock(
                ingredient_id=item.ingredient_id,
                location_id=transfer.to_location_id,
                quantity=qty,
                unit_cost=sender_stock.unit_cost,
                movement_type=MovementType.TRANSFER_IN,
                reference_type='transfer',
                reference_id=transfer.id,
            )

        transfer.status = TransferStatus.RECEIVED
        transfer.received_at = timezone.now()
        transfer.save(update_fields=['status', 'received_at', 'updated_at'])

    return transfer


def cancel_transfer(transfer_id):
    """Cancel a transfer.

    Allowed from REQUESTED or APPROVED (state machine).

    FIX(audit-3): If the transfer was APPROVED, stock was already deducted
    from the sender on approval. Cancelling MUST restore that stock — the
    previous implementation just flipped the status and silently lost the
    sender's stock.
    """
    with transaction.atomic():
        transfer = (
            StockTransfer.objects
            .select_for_update()
            .get(id=transfer_id)
        )
        _validate_transition(transfer.status, TransferStatus.CANCELLED)
        was_approved = transfer.status == TransferStatus.APPROVED

        if was_approved:
            for item in transfer.items.select_related('ingredient'):
                if item.approved_quantity is None or item.approved_quantity <= Decimal('0'):
                    continue
                stock_service.replenish_stock(
                    ingredient_id=item.ingredient_id,
                    location_id=transfer.from_location_id,
                    quantity=item.approved_quantity,
                    unit_cost=Decimal('0'),  # cost preserved via weighted-avg
                    movement_type=MovementType.TRANSFER_IN,  # treat as reversal
                    reference_type='transfer_cancel',
                    reference_id=transfer.id,
                    notes='Cancellation of approved transfer — sender stock restored.',
                )

        transfer.status = TransferStatus.CANCELLED
        transfer.save(update_fields=['status', 'updated_at'])

    return transfer
