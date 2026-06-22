"""Inventory domain models.

Organised in five layers:

1. Foundation          — InventoryUnit, IngredientCategory, Ingredient
2. Stock tracking      — StockLevel (current balance), StockMovement (audit ledger)
3. Supplier & Procure  — Supplier, SupplierIngredient, PurchaseOrder, PurchaseOrderItem
4. Batch & Wastage     — Batch (lot/expiry tracking), WastageLog
5. Transfers & Recipes — StockTransfer, StockTransferItem, Recipe, RecipeIngredient

Design invariants:
- All stock mutations go through services that acquire ``select_for_update()``
  locks on StockLevel before writing.
- Every mutation creates a StockMovement row (the append-only ledger).
- StockLevel.quantity is the materialised balance; it can always be
  reconstructed by summing StockMovement.quantity for (ingredient, location).
- Batch consumption follows FIFO (oldest batch first).

------------------------------------------------------------------------------
PRODUCTION READINESS AUDIT — see AUDIT.md in this folder for the full report.
Inline ``# FIXME(audit-N)`` tags below correspond to numbered findings there.
Critical open items: audit-1 (tenant boundary), audit-6 (InventoryUnit on_delete),
audit-9 (number-generator races), audit-11 (signal idempotency), audit-17 (no
expiry job), audit-18 (FIFO vs FEFO). These are NOT fully fixed in code yet.
------------------------------------------------------------------------------
"""

from decimal import Decimal

from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from core.models import BaseModel


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class MovementType(models.TextChoices):
    """Why stock changed — recorded on every StockMovement."""
    PURCHASE_RECEIPT = 'purchase_receipt', 'Purchase Receipt'
    MANUAL_ADJUSTMENT = 'manual_adjustment', 'Manual Adjustment'
    ORDER_DEDUCTION = 'order_deduction', 'Order Deduction'
    WASTAGE = 'wastage', 'Wastage'
    TRANSFER_OUT = 'transfer_out', 'Transfer Out'
    TRANSFER_IN = 'transfer_in', 'Transfer In'
    OPENING_STOCK = 'opening_stock', 'Opening Stock'
    PHYSICAL_COUNT = 'physical_count', 'Physical Count'


class POStatus(models.TextChoices):
    DRAFT = 'draft', 'Draft'
    SUBMITTED = 'submitted', 'Submitted'
    PARTIALLY_RECEIVED = 'partially_received', 'Partially Received'
    FULLY_RECEIVED = 'fully_received', 'Fully Received'
    CANCELLED = 'cancelled', 'Cancelled'


class TransferStatus(models.TextChoices):
    REQUESTED = 'requested', 'Requested'
    APPROVED = 'approved', 'Approved'
    REJECTED = 'rejected', 'Rejected'
    DISPATCHED = 'dispatched', 'Dispatched'
    RECEIVED = 'received', 'Received'
    CANCELLED = 'cancelled', 'Cancelled'


class WastageReason(models.TextChoices):
    EXPIRED = 'expired', 'Expired'
    SPOILED = 'spoiled', 'Spoiled'
    OVER_PREPARED = 'over_prepared', 'Over-Prepared'
    DROPPED = 'dropped', 'Dropped'
    OTHER = 'other', 'Other'


class BatchStatus(models.TextChoices):
    ACTIVE = 'active', 'Active'
    EXPIRED = 'expired', 'Expired'
    CONSUMED = 'consumed', 'Consumed'
    WASTED = 'wasted', 'Wasted'


class CostMethod(models.TextChoices):
    WEIGHTED_AVERAGE = 'weighted_average', 'Weighted Average'
    LATEST_PRICE = 'latest_price', 'Latest Price'


class AdjustmentReason(models.TextChoices):
    """Predefined reasons for manual stock adjustments (F-20)."""
    PHYSICAL_COUNT = 'physical_count', 'Physical Count Correction'
    UNTRACKED_USAGE = 'untracked_usage', 'Untracked Usage'
    OTHER = 'other', 'Other'


# ---------------------------------------------------------------------------
# 1. Foundation — units, categories, ingredients
# ---------------------------------------------------------------------------

class InventoryUnit(BaseModel):
    """Measurement unit for ingredients (kg, g, L, mL, piece, dozen …).

    Supports unit conversion via ``base_unit`` + ``conversion_factor``.
    E.g. 1 kg = 1000 g  →  base_unit = g, conversion_factor = 1000.
    A unit with base_unit = NULL is itself a base unit (factor ignored).
    """

    name = models.CharField(max_length=60, help_text='Full name, e.g. "Kilogram"')
    short_name = models.CharField(max_length=10, help_text='Abbreviation, e.g. "kg"')
    # FIXME(audit-6): on_delete=SET_NULL silently corrupts every derived unit's
    # conversion factor when the base is deleted. Change to PROTECT in a new
    # migration AFTER auditing existing data for orphaned references.
    base_unit = models.ForeignKey(
        'self',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='derived_units',
        help_text='The base unit this converts into (NULL = this IS the base unit)',
    )
    conversion_factor = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=Decimal('1'),
        validators=[MinValueValidator(Decimal('0.0001'))],
        help_text='1 of THIS unit = <factor> of base_unit',
    )
    restaurant = models.ForeignKey(
        'core.Restaurant',
        on_delete=models.CASCADE,
        related_name='inventory_units',
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['short_name', 'restaurant'],
                name='uniq_inv_unit_shortname_restaurant',
            ),
        ]
        ordering = ['name']

    def clean(self):
        if self.base_unit_id and self.base_unit_id == self.id:
            raise ValidationError('A unit cannot be its own base unit.')
        # Cycle detection: walking up the base_unit chain must terminate.
        seen = {self.id} if self.id else set()
        cursor = self.base_unit
        while cursor is not None:
            if cursor.id in seen:
                raise ValidationError(
                    'InventoryUnit chain forms a cycle through '
                    f'{cursor.short_name}.'
                )
            seen.add(cursor.id)
            cursor = cursor.base_unit
        # Tenant boundary: base_unit must belong to same restaurant.
        if (
            self.base_unit_id
            and self.restaurant_id
            and self.base_unit.restaurant_id != self.restaurant_id
        ):
            raise ValidationError(
                'base_unit must belong to the same restaurant.'
            )

    def __str__(self):
        return f'{self.short_name} ({self.name})'


class IngredientCategory(BaseModel):
    """Grouping for ingredients (Produce, Dairy, Dry Goods, Spices …)."""

    name = models.CharField(max_length=80)
    description = models.TextField(blank=True)
    restaurant = models.ForeignKey(
        'core.Restaurant',
        on_delete=models.CASCADE,
        related_name='ingredient_categories',
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['name', 'restaurant'],
                name='uniq_ingredient_category_name_restaurant',
            ),
        ]
        ordering = ['name']
        verbose_name_plural = 'ingredient categories'

    def __str__(self):
        return self.name


class Ingredient(BaseModel):
    """A raw material tracked in inventory (Onion, Chicken Breast, Olive Oil …).

    Scoped per restaurant; stock is tracked per location via StockLevel.
    """

    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    category = models.ForeignKey(
        IngredientCategory,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='ingredients',
    )
    unit = models.ForeignKey(
        InventoryUnit,
        on_delete=models.PROTECT,
        related_name='ingredients',
        help_text='Primary tracking unit (e.g. kg, L, piece)',
    )
    restaurant = models.ForeignKey(
        'core.Restaurant',
        on_delete=models.CASCADE,
        related_name='ingredients',
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['name', 'restaurant'],
                name='uniq_ingredient_name_restaurant',
            ),
        ]
        ordering = ['name']
        # FIXME(audit-27): Add Index(fields=['restaurant', 'is_active']) for the
        # primary list query. Requires a new migration.

    def clean(self):
        # FIXME(audit-1): Tenant boundary — unit and category must belong to the
        # same restaurant. Enforced at app level here; DB-level enforcement
        # requires a check constraint that joins, which Django can't express.
        if (
            self.unit_id
            and self.restaurant_id
            and self.unit.restaurant_id != self.restaurant_id
        ):
            raise ValidationError(
                'Ingredient.unit must belong to the same restaurant.'
            )
        if (
            self.category_id
            and self.restaurant_id
            and self.category.restaurant_id != self.restaurant_id
        ):
            raise ValidationError(
                'Ingredient.category must belong to the same restaurant.'
            )

    def __str__(self):
        return f'{self.name} ({self.unit.short_name})'


# ---------------------------------------------------------------------------
# 2. Stock tracking — balance + ledger
# ---------------------------------------------------------------------------

class StockLevel(BaseModel):
    """Current on-hand quantity of an ingredient at a specific location.

    One row per (ingredient, location). Updated atomically via services
    using ``select_for_update()`` to prevent race conditions.

    ``unit_cost`` tracks the current per-unit cost, recalculated on every
    purchase receipt using the chosen ``cost_method``.
    """

    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.CASCADE,
        related_name='stock_levels',
    )
    location = models.ForeignKey(
        'core.Location',
        on_delete=models.CASCADE,
        related_name='stock_levels',
    )
    quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=Decimal('0'),
        help_text='Current on-hand quantity in ingredient.unit',
    )
    low_stock_threshold = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text='Alert when quantity drops below this value',
    )
    reorder_point = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text='Suggested quantity at which to reorder',
    )
    reorder_quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text='Suggested quantity to order when reorder_point is reached',
    )
    unit_cost = models.DecimalField(
        max_digits=10,
        decimal_places=4,
        default=Decimal('0'),
        help_text='Current cost per unit (weighted avg or latest price)',
    )
    cost_method = models.CharField(
        max_length=20,
        choices=CostMethod.choices,
        default=CostMethod.WEIGHTED_AVERAGE,
    )
    last_restocked_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text='Timestamp of last purchase receipt for this ingredient',
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['ingredient', 'location'],
                name='uniq_stocklevel_ingredient_location',
            ),
            models.CheckConstraint(
                condition=models.Q(quantity__gte=Decimal('0')),
                name='stocklevel_quantity_non_negative',
            ),
        ]
        indexes = [
            models.Index(
                fields=['location', 'quantity'],
                name='idx_stocklevel_location_qty',
            ),
        ]

    def clean(self):
        # FIXME(audit-1): tenant boundary — ingredient and location must belong
        # to the same restaurant.
        if (
            self.ingredient_id
            and self.location_id
            and self.ingredient.restaurant_id != self.location.restaurant_id
        ):
            raise ValidationError(
                'StockLevel.ingredient and StockLevel.location must belong to '
                'the same restaurant.'
            )

    @property
    def is_low_stock(self):
        """True if quantity is at or below the configured threshold."""
        if self.low_stock_threshold is None:
            return False
        return self.quantity <= self.low_stock_threshold

    @property
    def is_out_of_stock(self):
        return self.quantity <= Decimal('0')

    @property
    def stock_value(self):
        """Total value of current stock: quantity × unit_cost."""
        return self.quantity * self.unit_cost

    def __str__(self):
        return f'{self.ingredient.name} @ {self.location.name}: {self.quantity} {self.ingredient.unit.short_name}'


class StockMovement(BaseModel):
    """Append-only audit ledger of every stock change.

    Positive ``quantity`` = stock in; negative = stock out.
    ``quantity_before`` and ``quantity_after`` are snapshots of
    StockLevel.quantity at the time of the movement for easy auditing.
    """

    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.CASCADE,
        related_name='stock_movements',
    )
    location = models.ForeignKey(
        'core.Location',
        on_delete=models.CASCADE,
        related_name='stock_movements',
    )
    movement_type = models.CharField(
        max_length=30,
        choices=MovementType.choices,
        db_index=True,
    )
    quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        help_text='+ve = stock in, −ve = stock out',
    )
    quantity_before = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        help_text='StockLevel.quantity before this movement',
    )
    quantity_after = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        help_text='StockLevel.quantity after this movement',
    )
    unit_cost = models.DecimalField(
        max_digits=10,
        decimal_places=4,
        null=True,
        blank=True,
        help_text='Per-unit cost at time of movement (for receipt/wastage costing)',
    )
    # Generic reference to the source record (PO, Transfer, WastageLog, Order…).
    # Using reference_type + reference_id instead of GenericForeignKey to keep
    # the schema clean and avoid content-type queries.
    reference_type = models.CharField(
        max_length=30,
        blank=True,
        db_index=True,
        help_text='Source entity type: purchase_order, transfer, wastage, order, adjustment',
    )
    reference_id = models.UUIDField(
        null=True,
        blank=True,
        help_text='PK of the source entity',
    )
    batch = models.ForeignKey(
        'Batch',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='movements',
    )
    reason = models.CharField(
        max_length=30,
        choices=AdjustmentReason.choices,
        blank=True,
        help_text='Adjustment reason (only for manual_adjustment / physical_count)',
    )
    notes = models.TextField(blank=True)
    performed_by = models.ForeignKey(
        'core.StaffUser',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='stock_movements',
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(
                fields=['location', 'ingredient', 'created_at'],
                name='idx_movement_loc_ingr_date',
            ),
            models.Index(
                fields=['reference_type', 'reference_id'],
                name='idx_movement_reference',
            ),
        ]

    def __str__(self):
        sign = '+' if self.quantity >= 0 else ''
        return (
            f'{self.get_movement_type_display()}: '
            f'{sign}{self.quantity} {self.ingredient.name} '
            f'@ {self.location.name}'
        )


# ---------------------------------------------------------------------------
# 3. Supplier & Procurement
# ---------------------------------------------------------------------------

class Supplier(BaseModel):
    """Supplier directory entry (F-24).

    Scoped per restaurant. Tracks contact details, payment terms,
    and a quality/reliability rating.
    """

    name = models.CharField(max_length=120)
    contact_person = models.CharField(max_length=120, blank=True)
    phone = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)
    address = models.TextField(blank=True)
    gst_number = models.CharField(max_length=20, blank=True, help_text='GSTIN')
    fssai_license = models.CharField(
        max_length=20,
        blank=True,
        help_text='FSSAI license number (F-70 compliance)',
    )
    payment_terms = models.TextField(blank=True, help_text='e.g. "Net 30"')
    rating = models.DecimalField(
        max_digits=3,
        decimal_places=2,
        null=True,
        blank=True,
        validators=[
            MinValueValidator(Decimal('0')),
            # FIXME(audit-8): MaxValueValidator(5) was missing — DB check_constraint
            # below catches it at write, but app-level validators never raised
            # for bad input. Requires ``makemigrations inventory`` to record.
            MaxValueValidator(Decimal('5')),
        ],
        help_text='0.00 – 5.00',
    )
    restaurant = models.ForeignKey(
        'core.Restaurant',
        on_delete=models.CASCADE,
        related_name='suppliers',
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['name', 'restaurant'],
                name='uniq_supplier_name_restaurant',
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(rating__isnull=True)
                    | models.Q(rating__gte=Decimal('0'), rating__lte=Decimal('5'))
                ),
                name='supplier_rating_range',
            ),
        ]
        ordering = ['name']

    def __str__(self):
        return self.name


class SupplierIngredient(BaseModel):
    """Which ingredients a supplier provides (M2M through table).

    Tracks the last-known price and typical lead time for ordering decisions.
    """

    supplier = models.ForeignKey(
        Supplier,
        on_delete=models.CASCADE,
        related_name='supplied_ingredients',
    )
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.CASCADE,
        related_name='suppliers',
    )
    preferred_price = models.DecimalField(
        max_digits=10,
        decimal_places=4,
        null=True,
        blank=True,
        help_text='Last known / negotiated price per unit',
    )
    lead_time_days = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text='Typical delivery time in days',
    )
    is_preferred = models.BooleanField(
        default=False,
        help_text='Mark one supplier as preferred per ingredient',
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['supplier', 'ingredient'],
                name='uniq_supplier_ingredient',
            ),
        ]

    def __str__(self):
        return f'{self.supplier.name} → {self.ingredient.name}'


class PurchaseOrder(BaseModel):
    """Purchase order to a supplier (F-25).

    Lifecycle: Draft → Submitted → Partially Received → Fully Received
                                 → Cancelled
    """

    po_number = models.CharField(
        max_length=30,
        help_text='Auto-generated: PO-{location_code}-{seq}',
    )
    supplier = models.ForeignKey(
        Supplier,
        on_delete=models.PROTECT,
        related_name='purchase_orders',
    )
    location = models.ForeignKey(
        'core.Location',
        on_delete=models.CASCADE,
        related_name='purchase_orders',
    )
    status = models.CharField(
        max_length=25,
        choices=POStatus.choices,
        default=POStatus.DRAFT,
        db_index=True,
    )
    order_date = models.DateField(help_text='Date the PO was created / placed')
    expected_delivery_date = models.DateField(
        null=True,
        blank=True,
    )
    notes = models.TextField(blank=True)
    subtotal = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0'))
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0'))
    total_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0'))
    created_by = models.ForeignKey(
        'core.StaffUser',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='purchase_orders_created',
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['po_number', 'location'],
                name='uniq_po_number_location',
            ),
        ]
        ordering = ['-order_date', '-created_at']
        indexes = [
            models.Index(fields=['location', 'status'], name='idx_po_location_status'),
        ]

    def clean(self):
        if self.total_amount < Decimal('0'):
            raise ValidationError('Total amount cannot be negative.')
        # FIXME(audit-1): supplier must belong to the same restaurant as
        # location.restaurant.
        if (
            self.supplier_id
            and self.location_id
            and self.supplier.restaurant_id != self.location.restaurant_id
        ):
            raise ValidationError(
                'PurchaseOrder.supplier and PurchaseOrder.location must belong '
                'to the same restaurant.'
            )
        # FIXME(audit-8): expected_delivery_date must not precede order_date.
        if (
            self.expected_delivery_date
            and self.order_date
            and self.expected_delivery_date < self.order_date
        ):
            raise ValidationError(
                'expected_delivery_date cannot be before order_date.'
            )

    def __str__(self):
        return f'{self.po_number} [{self.get_status_display()}] — {self.supplier.name}'


class PurchaseOrderItem(BaseModel):
    """Line item in a purchase order."""

    purchase_order = models.ForeignKey(
        PurchaseOrder,
        on_delete=models.CASCADE,
        related_name='items',
    )
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.PROTECT,
        related_name='purchase_order_items',
    )
    ordered_quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.0001'))],
    )
    received_quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default=Decimal('0'),
    )
    unit_price = models.DecimalField(
        max_digits=10,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0'))],
        help_text='Expected unit price when ordering',
    )
    received_unit_price = models.DecimalField(
        max_digits=10,
        decimal_places=4,
        null=True,
        blank=True,
        help_text='Actual unit price on receipt (may differ from expected)',
    )

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(ordered_quantity__gt=Decimal('0')),
                name='poitem_ordered_qty_positive',
            ),
            models.CheckConstraint(
                condition=models.Q(received_quantity__gte=Decimal('0')),
                name='poitem_received_qty_non_negative',
            ),
            # FIXME(audit-8): Add a DB-level CheckConstraint
            #   received_quantity <= ordered_quantity
            # Django 5 supports column-vs-column via F expression in CheckConstraint,
            # but it requires a new migration. Currently enforced only at service
            # layer (purchase_order_service.receive_po_item).
            models.CheckConstraint(
                condition=models.Q(received_quantity__lte=models.F('ordered_quantity')),
                name='poitem_received_le_ordered',
            ),
        ]

    @property
    def is_fully_received(self):
        return self.received_quantity >= self.ordered_quantity

    @property
    def pending_quantity(self):
        return max(Decimal('0'), self.ordered_quantity - self.received_quantity)

    @property
    def total_price(self):
        """Expected total = ordered_quantity × unit_price."""
        return self.ordered_quantity * self.unit_price

    @property
    def received_total(self):
        """Actual received total = received_quantity × received_unit_price."""
        price = self.received_unit_price or self.unit_price
        return self.received_quantity * price

    def __str__(self):
        return f'{self.ingredient.name}: {self.received_quantity}/{self.ordered_quantity}'


# ---------------------------------------------------------------------------
# 4. Batch tracking & Wastage
# ---------------------------------------------------------------------------

class Batch(BaseModel):
    """Batch / lot record for an ingredient at a location (F-22).

    Created on purchase receipt. FIFO consumption deducts from the oldest
    active batch first. Celery tasks flag batches approaching expiry.
    """

    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.CASCADE,
        related_name='batches',
    )
    location = models.ForeignKey(
        'core.Location',
        on_delete=models.CASCADE,
        related_name='batches',
    )
    batch_number = models.CharField(
        max_length=60,
        help_text='Auto-generated if blank: RECV-{loc_code}-{date}-{seq}',
    )
    manufacture_date = models.DateField(null=True, blank=True)
    expiry_date = models.DateField(null=True, blank=True)
    received_quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.0001'))],
        help_text='Original quantity received',
    )
    remaining_quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        help_text='Current remaining after FIFO consumption',
    )
    unit_cost = models.DecimalField(
        max_digits=10,
        decimal_places=4,
        default=Decimal('0'),
        help_text='Cost per unit at time of receipt',
    )
    supplier = models.ForeignKey(
        Supplier,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='batches',
    )
    purchase_order_item = models.ForeignKey(
        PurchaseOrderItem,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='batches',
    )
    fssai_mfg_license = models.CharField(
        max_length=30,
        blank=True,
        help_text="Supplier's manufacturing license (FSSAI compliance)",
    )
    status = models.CharField(
        max_length=20,
        choices=BatchStatus.choices,
        default=BatchStatus.ACTIVE,
        db_index=True,
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['batch_number', 'location'],
                name='uniq_batch_number_location',
            ),
            models.CheckConstraint(
                condition=models.Q(remaining_quantity__gte=Decimal('0')),
                name='batch_remaining_non_negative',
            ),
            # FIXME(audit-8): Promote ``clean()``'s remaining<=received check to
            # a DB-level constraint. Run ``makemigrations inventory``.
            models.CheckConstraint(
                condition=models.Q(remaining_quantity__lte=models.F('received_quantity')),
                name='batch_remaining_le_received',
            ),
        ]
        ordering = ['created_at']  # FIFO — oldest first
        # FIXME(audit-18): For perishables we want FEFO (first expire first out),
        # not FIFO. Service layer should order by ``expiry_date NULLS LAST, created_at``
        # before consuming. See stock_service._deduct_fifo_batches.
        indexes = [
            models.Index(
                fields=['location', 'ingredient', 'status'],
                name='idx_batch_loc_ingr_status',
            ),
            models.Index(
                fields=['expiry_date'],
                name='idx_batch_expiry',
            ),
        ]
        verbose_name_plural = 'batches'

    def clean(self):
        if (
            self.manufacture_date
            and self.expiry_date
            and self.expiry_date <= self.manufacture_date
        ):
            raise ValidationError('Expiry date must be after manufacture date.')
        if self.remaining_quantity > self.received_quantity:
            raise ValidationError('Remaining quantity cannot exceed received quantity.')
        # FIXME(audit-1): tenant boundary checks.
        if (
            self.ingredient_id
            and self.location_id
            and self.ingredient.restaurant_id != self.location.restaurant_id
        ):
            raise ValidationError(
                'Batch.ingredient and Batch.location must belong to the same restaurant.'
            )
        if (
            self.supplier_id
            and self.location_id
            and self.supplier.restaurant_id != self.location.restaurant_id
        ):
            raise ValidationError(
                'Batch.supplier and Batch.location must belong to the same restaurant.'
            )

    def __str__(self):
        return f'Batch {self.batch_number}: {self.ingredient.name} ({self.remaining_quantity} left)'


class WastageLog(BaseModel):
    """Wastage record for an ingredient (F-23).

    Deducts from stock and optionally from a specific batch.
    Feeds into food waste analytics (F-62).
    """

    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.CASCADE,
        related_name='wastage_logs',
    )
    location = models.ForeignKey(
        'core.Location',
        on_delete=models.CASCADE,
        related_name='wastage_logs',
    )
    batch = models.ForeignKey(
        Batch,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='wastage_logs',
    )
    quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.0001'))],
    )
    estimated_cost = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=Decimal('0'),
        help_text='qty × unit_cost at time of waste',
    )
    reason = models.CharField(
        max_length=30,
        choices=WastageReason.choices,
    )
    notes = models.TextField(blank=True)
    logged_by = models.ForeignKey(
        'core.StaffUser',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='wastage_logs',
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(
                fields=['location', 'ingredient', 'created_at'],
                name='idx_wastage_loc_ingr_date',
            ),
            models.Index(
                fields=['reason'],
                name='idx_wastage_reason',
            ),
        ]

    def __str__(self):
        return f'Waste: {self.quantity} {self.ingredient.name} ({self.get_reason_display()})'


# ---------------------------------------------------------------------------
# 5. Inter-location transfers & recipes
# ---------------------------------------------------------------------------

class StockTransfer(BaseModel):
    """Inter-location stock transfer (F-26).

    Workflow: Requested → Approved → Dispatched → Received
                        → Rejected
                        → Cancelled
    """

    transfer_number = models.CharField(
        max_length=30,
        help_text='Auto-generated: TRF-{date}-{seq}',
    )
    from_location = models.ForeignKey(
        'core.Location',
        on_delete=models.CASCADE,
        related_name='transfers_out',
    )
    to_location = models.ForeignKey(
        'core.Location',
        on_delete=models.CASCADE,
        related_name='transfers_in',
    )
    status = models.CharField(
        max_length=25,
        choices=TransferStatus.choices,
        default=TransferStatus.REQUESTED,
        db_index=True,
    )
    reason = models.TextField(blank=True)
    requested_by = models.ForeignKey(
        'core.StaffUser',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='transfer_requests',
    )
    approved_by = models.ForeignKey(
        'core.StaffUser',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='transfer_approvals',
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    received_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(
                fields=['from_location', 'status'],
                name='idx_transfer_from_status',
            ),
            models.Index(
                fields=['to_location', 'status'],
                name='idx_transfer_to_status',
            ),
        ]

    def clean(self):
        if self.from_location_id and self.to_location_id:
            if self.from_location_id == self.to_location_id:
                raise ValidationError('Cannot transfer stock to the same location.')
            # FIXME(audit-1): tenant boundary — both locations must belong to
            # the same restaurant. Without this, two tenants on the same DB
            # can transfer stock to each other.
            if (
                self.from_location.restaurant_id
                != self.to_location.restaurant_id
            ):
                raise ValidationError(
                    'Cannot transfer stock between different restaurants.'
                )

    def __str__(self):
        return f'{self.transfer_number} [{self.get_status_display()}]'


class StockTransferItem(BaseModel):
    """Line item in a stock transfer."""

    transfer = models.ForeignKey(
        StockTransfer,
        on_delete=models.CASCADE,
        related_name='items',
    )
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.PROTECT,
        related_name='transfer_items',
    )
    requested_quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.0001'))],
    )
    approved_quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text='Sender can approve a partial amount',
    )
    received_quantity = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(requested_quantity__gt=Decimal('0')),
                name='transferitem_requested_positive',
            ),
        ]

    def __str__(self):
        return f'{self.ingredient.name}: {self.requested_quantity}'


class Recipe(BaseModel):
    """Maps a menu item (+ optional variant) to its ingredient list (F-15).

    If ``variant`` is NULL the recipe applies to all variants of the item.
    A variant-specific recipe overrides the item-level recipe.
    """

    menu_item = models.ForeignKey(
        'menu.MenuItem',
        on_delete=models.CASCADE,
        related_name='recipes',
    )
    variant = models.ForeignKey(
        'menu.Variant',
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name='recipes',
    )
    name = models.CharField(
        max_length=120,
        blank=True,
        help_text='Optional label (auto-set from menu item if blank)',
    )
    # FIXME(audit-23): added is_active so a recipe can be deactivated (e.g. for
    # seasonal items) without deleting it. Run ``makemigrations inventory``.
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['menu_item', 'variant'],
                name='uniq_recipe_item_variant',
            ),
        ]

    def save(self, *args, **kwargs):
        if not self.name:
            variant_label = f' — {self.variant.name}' if self.variant else ''
            self.name = f'{self.menu_item.name}{variant_label}'
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class RecipeIngredient(BaseModel):
    """Quantity of an ingredient consumed per 1 serving of a recipe (F-15).

    Used for auto-deduction on order and for recipe cost calculation (F-16).
    """

    recipe = models.ForeignKey(
        Recipe,
        on_delete=models.CASCADE,
        related_name='ingredients',
    )
    ingredient = models.ForeignKey(
        Ingredient,
        on_delete=models.PROTECT,
        related_name='recipe_usages',
    )
    quantity = models.DecimalField(
        max_digits=10,
        decimal_places=4,
        validators=[MinValueValidator(Decimal('0.0001'))],
        help_text='Quantity consumed per 1 serving',
    )
    unit = models.ForeignKey(
        InventoryUnit,
        on_delete=models.PROTECT,
        related_name='+',
        help_text='Unit for this recipe line (should be convertible to ingredient.unit)',
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['recipe', 'ingredient'],
                name='uniq_recipe_ingredient',
            ),
            models.CheckConstraint(
                condition=models.Q(quantity__gt=Decimal('0')),
                name='recipe_ingredient_qty_positive',
            ),
        ]

    def clean(self):
        # FIXME(audit-25): the recipe ``unit`` must be convertible to the
        # ingredient's tracking unit. Catching this at save-time rather than
        # at deduction-time avoids a confusing runtime error during ordering.
        if self.unit_id and self.ingredient_id:
            from_base = self.unit.base_unit_id or self.unit_id
            to_base = self.ingredient.unit.base_unit_id or self.ingredient.unit_id
            same_chain = (
                from_base == to_base
                or self.unit_id == to_base
                or self.ingredient.unit_id == from_base
            )
            if not same_chain:
                raise ValidationError(
                    f'Recipe unit {self.unit.short_name} cannot be converted '
                    f'to ingredient unit {self.ingredient.unit.short_name}.'
                )
        # FIXME(audit-1): tenant boundary.
        if (
            self.recipe_id
            and self.ingredient_id
            and self.recipe.menu_item_id
        ):
            menu_restaurant = (
                self.recipe.menu_item.category.location.restaurant_id
            )
            if self.ingredient.restaurant_id != menu_restaurant:
                raise ValidationError(
                    'RecipeIngredient.ingredient must belong to the same '
                    "restaurant as the recipe's menu_item."
                )

    def __str__(self):
        return f'{self.quantity} {self.unit.short_name} {self.ingredient.name}'
