"""
Purchase order lifecycle: create, submit, receive, cancel (F-25).

On receipt, stock is replenished, costs recalculated, and batches optionally
created for lot/expiry tracking (F-22).
"""

from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from inventory.models import (
    Batch,
    POStatus,
    PurchaseOrder,
    PurchaseOrderItem,
    SupplierIngredient,
)
from inventory.services import stock_service
from inventory.models import MovementType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def generate_po_number(location):
    """Generate sequential PO number: PO-{LOC_CODE}-{seq:04d}."""
    prefix = location.name[:6].upper().replace(' ', '')
    count = PurchaseOrder.objects.filter(location=location).count()
    return f'PO-{prefix}-{count + 1:04d}'


def _generate_batch_number(location, date):
    """Auto-generate batch number: RECV-{LOC}-{YYYYMMDD}-{seq:03d}."""
    prefix = location.name[:6].upper().replace(' ', '')
    date_str = date.strftime('%Y%m%d')
    count = Batch.objects.filter(
        location=location,
        batch_number__startswith=f'RECV-{prefix}-{date_str}',
    ).count()
    return f'RECV-{prefix}-{date_str}-{count + 1:03d}'


def _recalculate_po_totals(po):
    """Recalculate PO subtotal and total from line items."""
    subtotal = Decimal('0')
    for item in po.items.all():
        if item.received_unit_price is not None and item.received_quantity > 0:
            subtotal += item.received_quantity * item.received_unit_price
        else:
            subtotal += item.ordered_quantity * item.unit_price
    po.subtotal = subtotal
    po.total_amount = subtotal + po.tax_amount
    po.save(update_fields=['subtotal', 'total_amount', 'updated_at'])


# ---------------------------------------------------------------------------
# PO lifecycle
# ---------------------------------------------------------------------------

def create_purchase_order(
    *,
    supplier_id,
    location_id,
    order_date,
    items_data,
    expected_delivery_date=None,
    notes='',
    created_by=None,
):
    """Create a PO with line items atomically.

    ``items_data``: list of dicts with keys:
        ingredient_id, ordered_quantity, unit_price
    """
    if not items_data:
        raise ValueError('Purchase order must have at least one item.')

    with transaction.atomic():
        from core.models import Location
        location = Location.objects.get(id=location_id)
        po_number = generate_po_number(location)

        subtotal = sum(
            Decimal(str(item['ordered_quantity'])) * Decimal(str(item['unit_price']))
            for item in items_data
        )

        po = PurchaseOrder.objects.create(
            po_number=po_number,
            supplier_id=supplier_id,
            location_id=location_id,
            order_date=order_date,
            expected_delivery_date=expected_delivery_date,
            notes=notes,
            subtotal=subtotal,
            total_amount=subtotal,
            created_by=created_by,
        )

        for item_data in items_data:
            PurchaseOrderItem.objects.create(
                purchase_order=po,
                ingredient_id=item_data['ingredient_id'],
                ordered_quantity=item_data['ordered_quantity'],
                unit_price=item_data['unit_price'],
            )

    return po


def submit_purchase_order(po_id):
    """Transition PO from Draft → Submitted."""
    with transaction.atomic():
        po = PurchaseOrder.objects.select_for_update().get(id=po_id)
        if po.status != POStatus.DRAFT:
            raise ValueError(
                f'Cannot submit PO in status "{po.get_status_display()}". '
                'Only Draft POs can be submitted.'
            )
        po.status = POStatus.SUBMITTED
        po.save(update_fields=['status', 'updated_at'])
    return po


def receive_po_item(
    *,
    po_item_id,
    received_quantity,
    received_unit_price=None,
    batch_number='',
    manufacture_date=None,
    expiry_date=None,
    fssai_mfg_license='',
    performed_by=None,
):
    """Receive a single PO line item (supports partial receipt).

    Creates a Batch if batch tracking data is provided, replenishes stock,
    and updates PO status and supplier pricing.
    """
    received_quantity = Decimal(str(received_quantity))
    if received_quantity <= Decimal('0'):
        raise ValueError('Received quantity must be positive.')

    with transaction.atomic():
        po_item = (
            PurchaseOrderItem.objects
            .select_for_update()
            .select_related('purchase_order', 'purchase_order__location', 'purchase_order__supplier', 'ingredient')
            .get(id=po_item_id)
        )
        po = po_item.purchase_order

        # Validate PO status
        if po.status not in (POStatus.SUBMITTED, POStatus.PARTIALLY_RECEIVED):
            raise ValueError(
                f'Cannot receive items on PO in status "{po.get_status_display()}". '
                'PO must be Submitted or Partially Received.'
            )

        # Validate quantity
        pending = po_item.pending_quantity
        if received_quantity > pending:
            raise ValueError(
                f'Received quantity ({received_quantity}) exceeds pending '
                f'quantity ({pending}) for {po_item.ingredient.name}.'
            )

        # Determine unit price
        actual_price = (
            Decimal(str(received_unit_price))
            if received_unit_price is not None
            else po_item.unit_price
        )

        # Update PO item
        po_item.received_quantity += received_quantity
        po_item.received_unit_price = actual_price
        po_item.save(update_fields=[
            'received_quantity', 'received_unit_price', 'updated_at',
        ])

        # Create batch if tracking data provided
        batch = None
        if batch_number or manufacture_date or expiry_date:
            if not batch_number:
                batch_number = _generate_batch_number(po.location, timezone.now().date())
            batch = Batch.objects.create(
                ingredient=po_item.ingredient,
                location=po.location,
                batch_number=batch_number,
                manufacture_date=manufacture_date,
                expiry_date=expiry_date,
                received_quantity=received_quantity,
                remaining_quantity=received_quantity,
                unit_cost=actual_price,
                supplier=po.supplier,
                purchase_order_item=po_item,
                fssai_mfg_license=fssai_mfg_license,
            )

        # Replenish stock
        stock_service.replenish_stock(
            ingredient_id=po_item.ingredient_id,
            location_id=po.location_id,
            quantity=received_quantity,
            unit_cost=actual_price,
            movement_type=MovementType.PURCHASE_RECEIPT,
            reference_type='purchase_order',
            reference_id=po.id,
            batch=batch,
            performed_by=performed_by,
        )

        # Update PO status
        all_items = po.items.all()
        all_received = all(item.is_fully_received for item in all_items)
        if all_received:
            po.status = POStatus.FULLY_RECEIVED
        else:
            po.status = POStatus.PARTIALLY_RECEIVED
        po.save(update_fields=['status', 'updated_at'])

        # Recalculate PO totals
        _recalculate_po_totals(po)

        # Update supplier preferred price
        SupplierIngredient.objects.update_or_create(
            supplier=po.supplier,
            ingredient=po_item.ingredient,
            defaults={'preferred_price': actual_price},
        )

    return po_item, batch


def cancel_purchase_order(po_id):
    """Cancel a PO. Only allowed if no items have been received."""
    with transaction.atomic():
        po = PurchaseOrder.objects.select_for_update().get(id=po_id)
        if po.status not in (POStatus.DRAFT, POStatus.SUBMITTED):
            raise ValueError(
                f'Cannot cancel PO in status "{po.get_status_display()}". '
                'Only Draft or Submitted POs can be cancelled.'
            )
        # Check no items received
        has_received = po.items.filter(received_quantity__gt=Decimal('0')).exists()
        if has_received:
            raise ValueError(
                'Cannot cancel PO — some items have already been received. '
                'Create adjustment entries instead.'
            )
        po.status = POStatus.CANCELLED
        po.save(update_fields=['status', 'updated_at'])
    return po
