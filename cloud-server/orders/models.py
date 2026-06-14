from django.db import models

from core.models import BaseModel


class Order(BaseModel):
    class OrderSource(models.TextChoices):
        STAFF_POS = 'Staff_POS', 'Staff POS'
        WAITER_APP = 'Waiter_App', 'Waiter App'
        USER_APP_QR = 'User_App_QR', 'User App QR'
        ONDC = 'ONDC', 'ONDC'
        WEB_DIRECT = 'Web_Direct', 'Web Direct'

    class Status(models.TextChoices):
        PENDING = 'Pending', 'Pending'
        CONFIRMED = 'Confirmed', 'Confirmed'
        PREPARING = 'Preparing', 'Preparing'
        READY = 'Ready', 'Ready'
        SERVED = 'Served', 'Served'
        CANCELLED = 'Cancelled', 'Cancelled'

    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='orders'
    )
    table = models.ForeignKey(
        'tables.Table',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='orders',
    )
    source = models.CharField(
        max_length=20,
        choices=OrderSource.choices,
        default=OrderSource.STAFF_POS,
        db_index=True,
    )
    status = models.CharField(
        max_length=15,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    total = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    customer_note = models.TextField(blank=True)
    idempotency_key = models.CharField(max_length=64, blank=True, db_index=True)
    created_by = models.ForeignKey(
        'core.StaffUser',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='orders_created',
    )

    class Meta:
        indexes = [
            models.Index(fields=['location', 'status']),
        ]

    def __str__(self):
        return f'Order {self.id} [{self.status}] @ {self.location}'


class OrderItem(BaseModel):
    order = models.ForeignKey(Order, related_name='items', on_delete=models.CASCADE)
    menu_item = models.ForeignKey(
        'menu.MenuItem', on_delete=models.PROTECT, related_name='order_items'
    )
    variant = models.ForeignKey(
        'menu.Variant', null=True, blank=True, on_delete=models.PROTECT
    )
    quantity = models.PositiveIntegerField(default=1)
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)
    notes = models.TextField(blank=True)

    def __str__(self):
        return f'{self.quantity}x {self.menu_item.name}'


class OrderItemModifier(BaseModel):
    order_item = models.ForeignKey(
        OrderItem, related_name='modifiers', on_delete=models.CASCADE
    )
    modifier = models.ForeignKey('menu.Modifier', on_delete=models.PROTECT)
    price = models.DecimalField(max_digits=10, decimal_places=2)

    def __str__(self):
        return f'{self.modifier.name} on {self.order_item}'
