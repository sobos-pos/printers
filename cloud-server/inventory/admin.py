from django.contrib import admin

from .models import (
    InventoryUnit,
    IngredientCategory,
    Ingredient,
    StockLevel,
    StockMovement,
    Supplier,
    SupplierIngredient,
    PurchaseOrder,
    PurchaseOrderItem,
    Batch,
    WastageLog,
    StockTransfer,
    StockTransferItem,
    Recipe,
    RecipeIngredient,
)


# ---------------------------------------------------------------------------
# Foundation
# ---------------------------------------------------------------------------

@admin.register(InventoryUnit)
class InventoryUnitAdmin(admin.ModelAdmin):
    list_display = ('short_name', 'name', 'base_unit', 'conversion_factor', 'restaurant')
    list_filter = ('restaurant',)
    search_fields = ('name', 'short_name')


@admin.register(IngredientCategory)
class IngredientCategoryAdmin(admin.ModelAdmin):
    list_display = ('name', 'restaurant', 'is_active')
    list_filter = ('restaurant', 'is_active')
    search_fields = ('name',)


@admin.register(Ingredient)
class IngredientAdmin(admin.ModelAdmin):
    list_display = ('name', 'category', 'unit', 'restaurant', 'is_active')
    list_filter = ('restaurant', 'category', 'is_active')
    search_fields = ('name',)


# ---------------------------------------------------------------------------
# Stock
# ---------------------------------------------------------------------------

@admin.register(StockLevel)
class StockLevelAdmin(admin.ModelAdmin):
    list_display = (
        'ingredient', 'location', 'quantity', 'low_stock_threshold',
        'unit_cost', 'cost_method', 'last_restocked_at',
    )
    list_filter = ('location', 'cost_method')
    search_fields = ('ingredient__name',)
    readonly_fields = ('quantity', 'unit_cost', 'last_restocked_at')


@admin.register(StockMovement)
class StockMovementAdmin(admin.ModelAdmin):
    list_display = (
        'ingredient', 'location', 'movement_type', 'quantity',
        'quantity_before', 'quantity_after', 'performed_by', 'created_at',
    )
    list_filter = ('location', 'movement_type', 'created_at')
    search_fields = ('ingredient__name', 'notes')
    readonly_fields = (
        'ingredient', 'location', 'movement_type', 'quantity',
        'quantity_before', 'quantity_after', 'unit_cost',
        'reference_type', 'reference_id', 'batch',
        'reason', 'notes', 'performed_by', 'created_at',
    )
    date_hierarchy = 'created_at'


# ---------------------------------------------------------------------------
# Supplier & Procurement
# ---------------------------------------------------------------------------

class SupplierIngredientInline(admin.TabularInline):
    model = SupplierIngredient
    extra = 1


@admin.register(Supplier)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ('name', 'contact_person', 'phone', 'email', 'rating', 'restaurant', 'is_active')
    list_filter = ('restaurant', 'is_active')
    search_fields = ('name', 'contact_person')
    inlines = [SupplierIngredientInline]


class PurchaseOrderItemInline(admin.TabularInline):
    model = PurchaseOrderItem
    extra = 1
    readonly_fields = ('received_quantity', 'received_unit_price')


@admin.register(PurchaseOrder)
class PurchaseOrderAdmin(admin.ModelAdmin):
    list_display = (
        'po_number', 'supplier', 'location', 'status',
        'order_date', 'total_amount', 'created_by',
    )
    list_filter = ('location', 'status', 'order_date')
    search_fields = ('po_number', 'supplier__name')
    readonly_fields = ('po_number', 'subtotal', 'total_amount')
    inlines = [PurchaseOrderItemInline]
    date_hierarchy = 'order_date'


# ---------------------------------------------------------------------------
# Batch & Wastage
# ---------------------------------------------------------------------------

@admin.register(Batch)
class BatchAdmin(admin.ModelAdmin):
    list_display = (
        'batch_number', 'ingredient', 'location', 'status',
        'received_quantity', 'remaining_quantity',
        'expiry_date', 'supplier',
    )
    list_filter = ('location', 'status', 'expiry_date')
    search_fields = ('batch_number', 'ingredient__name')
    readonly_fields = ('remaining_quantity',)
    date_hierarchy = 'created_at'


@admin.register(WastageLog)
class WastageLogAdmin(admin.ModelAdmin):
    list_display = (
        'ingredient', 'location', 'quantity', 'estimated_cost',
        'reason', 'logged_by', 'created_at',
    )
    list_filter = ('location', 'reason', 'created_at')
    search_fields = ('ingredient__name',)
    readonly_fields = (
        'ingredient', 'location', 'batch', 'quantity',
        'estimated_cost', 'reason', 'notes', 'logged_by',
    )
    date_hierarchy = 'created_at'


# ---------------------------------------------------------------------------
# Transfers
# ---------------------------------------------------------------------------

class StockTransferItemInline(admin.TabularInline):
    model = StockTransferItem
    extra = 1
    readonly_fields = ('approved_quantity', 'received_quantity')


@admin.register(StockTransfer)
class StockTransferAdmin(admin.ModelAdmin):
    list_display = (
        'transfer_number', 'from_location', 'to_location', 'status',
        'requested_by', 'approved_by', 'created_at',
    )
    list_filter = ('status', 'from_location', 'to_location')
    search_fields = ('transfer_number',)
    readonly_fields = ('transfer_number',)
    inlines = [StockTransferItemInline]


# ---------------------------------------------------------------------------
# Recipes
# ---------------------------------------------------------------------------

class RecipeIngredientInline(admin.TabularInline):
    model = RecipeIngredient
    extra = 1


@admin.register(Recipe)
class RecipeAdmin(admin.ModelAdmin):
    list_display = ('name', 'menu_item', 'variant')
    list_filter = ('menu_item__category__location',)
    search_fields = ('name', 'menu_item__name')
    inlines = [RecipeIngredientInline]
