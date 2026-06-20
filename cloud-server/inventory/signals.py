"""
Auto-deduct inventory when an order is confirmed.

Uses pre_save to detect status transitions. Fails silently to avoid
blocking order flow when recipes aren't configured or inventory tracking
is disabled.
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

    # Attempt deduction — never block the order
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
