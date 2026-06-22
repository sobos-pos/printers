"""
Auto-deduct inventory when an order is confirmed.

Uses pre_save to detect status transitions. Fails silently to avoid
blocking order flow when recipes aren't configured or inventory tracking
is disabled.

FIXME(audit-10): silent failure is the wrong default for a production POS —
the kitchen prepares the dish and inventory never deducts. Two correct
strategies: (a) block the order on insufficient stock; (b) write a dead-
letter row to ``InventoryDeductionFailure`` for staff to reconcile. Pick
one with the product team before launch.

FIXME(audit-11): this signal is NOT idempotent. Status Pending → Confirmed →
Pending → Confirmed deducts twice. We should:
   - either set ``Order.inventory_deducted_at`` after a successful deduction
     and skip when already set, OR
   - check for existing StockMovement(reference_type='order',
     reference_id=order.id) before deducting.
"""

import logging

from django.db.models.signals import pre_save
from django.dispatch import receiver

from orders.models import Order

logger = logging.getLogger('inventory')


@receiver(pre_save, sender=Order)
def auto_deduct_inventory_on_confirm(sender, instance, **kwargs):
    """Deduct ingredient stock when an order transitions to Confirmed.

    Only fires on status transitions TO 'Confirmed' — not on initial
    creation or other status changes.

    Silently logs and continues if deduction fails (recipes may not be
    configured, ingredient stock tracking may not be enabled for this
    restaurant, etc.). The order must never be blocked by inventory.
    """
    # Skip new (unsaved) orders
    if not instance.pk:
        return

    # Skip if status isn't changing to Confirmed
    if instance.status != Order.Status.CONFIRMED:
        return

    # Load the old status from DB to detect actual transition
    try:
        old_order = Order.objects.only('status').get(pk=instance.pk)
    except Order.DoesNotExist:
        return

    if old_order.status == instance.status:
        return  # Status didn't change

    # audit-11 partial guard: if any StockMovement already references this
    # order, skip — prevents the trivial Pending→Confirmed→Pending→Confirmed
    # double-deduct. Not a complete fix (no transactional fence) but stops
    # the obvious bug. Remove once Order.inventory_deducted_at is added.
    from inventory.models import StockMovement
    already_deducted = StockMovement.objects.filter(
        reference_type='order',
        reference_id=instance.pk,
    ).exists()
    if already_deducted:
        logger.info(
            'Inventory deduction skipped for order %s — already deducted '
            '(idempotency guard).',
            instance.pk,
        )
        return

    # Attempt deduction — never block the order (see audit-10 FIXME above).
    try:
        from inventory.services.recipe_service import deduct_ingredients_for_order
        deduct_ingredients_for_order(
            order_id=instance.pk,
            location_id=str(instance.location_id),
        )
        logger.info('Inventory deducted for order %s', instance.pk)
    except Exception as e:
        logger.warning(
            'Inventory deduction skipped for order %s: %s',
            instance.pk,
            str(e),
            exc_info=True,
        )
