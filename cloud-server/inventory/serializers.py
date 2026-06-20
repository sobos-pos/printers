from rest_framework import serializers

from .models import (
    Batch,
    Ingredient,
    IngredientCategory,
    InventoryUnit,
    PurchaseOrder,
    PurchaseOrderItem,
    Recipe,
    RecipeIngredient,
    StockLevel,
    StockMovement,
    StockTransfer,
    StockTransferItem,
    Supplier,
    SupplierIngredient,
    WastageLog,
)


# ---------------------------------------------------------------------------
# Foundation
# ---------------------------------------------------------------------------

class InventoryUnitSerializer(serializers.ModelSerializer):
    base_unit_name = serializers.CharField(source='base_unit.short_name', read_only=True, allow_null=True)

    class Meta:
        model = InventoryUnit
        fields = [
            'id', 'name', 'short_name', 'base_unit', 'base_unit_name',
            'conversion_factor', 'restaurant', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class IngredientCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = IngredientCategory
        fields = [
            'id', 'name', 'description', 'restaurant', 'is_active',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


class IngredientSerializer(serializers.ModelSerializer):
    unit_name = serializers.CharField(source='unit.short_name', read_only=True)
    category_name = serializers.CharField(source='category.name', read_only=True, allow_null=True)

    class Meta:
        model = Ingredient
        fields = [
            'id', 'name', 'description', 'category', 'category_name',
            'unit', 'unit_name', 'restaurant', 'is_active',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


# ---------------------------------------------------------------------------
# Stock
# ---------------------------------------------------------------------------

class StockLevelSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)
    unit_name = serializers.CharField(source='ingredient.unit.short_name', read_only=True)
    is_low_stock = serializers.BooleanField(read_only=True)
    is_out_of_stock = serializers.BooleanField(read_only=True)
    stock_value = serializers.DecimalField(max_digits=14, decimal_places=2, read_only=True)

    class Meta:
        model = StockLevel
        fields = [
            'id', 'ingredient', 'ingredient_name', 'location',
            'quantity', 'unit_name', 'low_stock_threshold',
            'reorder_point', 'reorder_quantity',
            'unit_cost', 'cost_method', 'last_restocked_at',
            'is_low_stock', 'is_out_of_stock', 'stock_value',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'quantity', 'unit_cost', 'last_restocked_at',
            'created_at', 'updated_at',
        ]


class StockMovementSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)
    movement_type_display = serializers.CharField(source='get_movement_type_display', read_only=True)
    performed_by_name = serializers.CharField(source='performed_by.username', read_only=True, allow_null=True)

    class Meta:
        model = StockMovement
        fields = [
            'id', 'ingredient', 'ingredient_name', 'location',
            'movement_type', 'movement_type_display',
            'quantity', 'quantity_before', 'quantity_after',
            'unit_cost', 'reference_type', 'reference_id',
            'batch', 'reason', 'notes',
            'performed_by', 'performed_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'created_at']


# ---------------------------------------------------------------------------
# Supplier
# ---------------------------------------------------------------------------

class SupplierIngredientSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)

    class Meta:
        model = SupplierIngredient
        fields = [
            'id', 'supplier', 'ingredient', 'ingredient_name',
            'preferred_price', 'lead_time_days', 'is_preferred',
        ]
        read_only_fields = ['id']


class SupplierSerializer(serializers.ModelSerializer):
    supplied_ingredients = SupplierIngredientSerializer(many=True, read_only=True)

    class Meta:
        model = Supplier
        fields = [
            'id', 'name', 'contact_person', 'phone', 'email',
            'address', 'gst_number', 'fssai_license',
            'payment_terms', 'rating', 'restaurant', 'is_active',
            'supplied_ingredients', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']


# ---------------------------------------------------------------------------
# Purchase Orders
# ---------------------------------------------------------------------------

class PurchaseOrderItemSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)
    is_fully_received = serializers.BooleanField(read_only=True)
    pending_quantity = serializers.DecimalField(max_digits=12, decimal_places=4, read_only=True)
    total_price = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)

    class Meta:
        model = PurchaseOrderItem
        fields = [
            'id', 'purchase_order', 'ingredient', 'ingredient_name',
            'ordered_quantity', 'received_quantity', 'unit_price',
            'received_unit_price', 'is_fully_received',
            'pending_quantity', 'total_price',
        ]
        read_only_fields = ['id', 'received_quantity', 'received_unit_price']


class PurchaseOrderSerializer(serializers.ModelSerializer):
    items = PurchaseOrderItemSerializer(many=True, read_only=True)
    supplier_name = serializers.CharField(source='supplier.name', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = PurchaseOrder
        fields = [
            'id', 'po_number', 'supplier', 'supplier_name', 'location',
            'status', 'status_display', 'order_date', 'expected_delivery_date',
            'notes', 'subtotal', 'tax_amount', 'total_amount',
            'created_by', 'items', 'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'po_number', 'subtotal', 'total_amount',
            'created_at', 'updated_at',
        ]


# ---------------------------------------------------------------------------
# Write serializers (for create/update operations)
# ---------------------------------------------------------------------------

class CreatePurchaseOrderItemSerializer(serializers.Serializer):
    ingredient_id = serializers.UUIDField()
    ordered_quantity = serializers.DecimalField(max_digits=12, decimal_places=4, min_value=0.0001)
    unit_price = serializers.DecimalField(max_digits=10, decimal_places=4, min_value=0)


class CreatePurchaseOrderSerializer(serializers.Serializer):
    supplier_id = serializers.UUIDField()
    location_id = serializers.UUIDField()
    order_date = serializers.DateField()
    expected_delivery_date = serializers.DateField(required=False, allow_null=True)
    notes = serializers.CharField(required=False, allow_blank=True, default='')
    items = CreatePurchaseOrderItemSerializer(many=True)


class ReceivePOItemSerializer(serializers.Serializer):
    po_item_id = serializers.UUIDField()
    received_quantity = serializers.DecimalField(max_digits=12, decimal_places=4, min_value=0.0001)
    received_unit_price = serializers.DecimalField(
        max_digits=10, decimal_places=4, required=False, allow_null=True,
    )
    batch_number = serializers.CharField(required=False, allow_blank=True, default='')
    manufacture_date = serializers.DateField(required=False, allow_null=True)
    expiry_date = serializers.DateField(required=False, allow_null=True)
    fssai_mfg_license = serializers.CharField(required=False, allow_blank=True, default='')


class AdjustStockSerializer(serializers.Serializer):
    ingredient_id = serializers.UUIDField()
    location_id = serializers.UUIDField()
    new_quantity = serializers.DecimalField(max_digits=12, decimal_places=4, min_value=0)
    reason = serializers.CharField()
    notes = serializers.CharField(required=False, allow_blank=True, default='')


class LogWastageSerializer(serializers.Serializer):
    ingredient_id = serializers.UUIDField()
    location_id = serializers.UUIDField()
    quantity = serializers.DecimalField(max_digits=12, decimal_places=4, min_value=0.0001)
    reason = serializers.CharField()
    batch_id = serializers.UUIDField(required=False, allow_null=True)
    notes = serializers.CharField(required=False, allow_blank=True, default='')


class CreateTransferItemSerializer(serializers.Serializer):
    ingredient_id = serializers.UUIDField()
    requested_quantity = serializers.DecimalField(max_digits=12, decimal_places=4, min_value=0.0001)


class CreateTransferSerializer(serializers.Serializer):
    from_location_id = serializers.UUIDField()
    to_location_id = serializers.UUIDField()
    reason = serializers.CharField(required=False, allow_blank=True, default='')
    items = CreateTransferItemSerializer(many=True)


# ---------------------------------------------------------------------------
# Batch & Wastage
# ---------------------------------------------------------------------------

class BatchSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)
    supplier_name = serializers.CharField(source='supplier.name', read_only=True, allow_null=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = Batch
        fields = [
            'id', 'ingredient', 'ingredient_name', 'location',
            'batch_number', 'manufacture_date', 'expiry_date',
            'received_quantity', 'remaining_quantity', 'unit_cost',
            'supplier', 'supplier_name', 'purchase_order_item',
            'fssai_mfg_license', 'status', 'status_display',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'remaining_quantity', 'status', 'created_at', 'updated_at']


class WastageLogSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)
    reason_display = serializers.CharField(source='get_reason_display', read_only=True)
    logged_by_name = serializers.CharField(source='logged_by.username', read_only=True, allow_null=True)

    class Meta:
        model = WastageLog
        fields = [
            'id', 'ingredient', 'ingredient_name', 'location',
            'batch', 'quantity', 'estimated_cost',
            'reason', 'reason_display', 'notes',
            'logged_by', 'logged_by_name', 'created_at',
        ]
        read_only_fields = ['id', 'estimated_cost', 'created_at']


# ---------------------------------------------------------------------------
# Transfer
# ---------------------------------------------------------------------------

class StockTransferItemSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)

    class Meta:
        model = StockTransferItem
        fields = [
            'id', 'transfer', 'ingredient', 'ingredient_name',
            'requested_quantity', 'approved_quantity', 'received_quantity',
        ]
        read_only_fields = ['id', 'approved_quantity', 'received_quantity']


class StockTransferSerializer(serializers.ModelSerializer):
    items = StockTransferItemSerializer(many=True, read_only=True)
    from_location_name = serializers.CharField(source='from_location.name', read_only=True)
    to_location_name = serializers.CharField(source='to_location.name', read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    class Meta:
        model = StockTransfer
        fields = [
            'id', 'transfer_number', 'from_location', 'from_location_name',
            'to_location', 'to_location_name', 'status', 'status_display',
            'reason', 'requested_by', 'approved_by', 'approved_at',
            'received_at', 'rejection_reason', 'items',
            'created_at', 'updated_at',
        ]
        read_only_fields = [
            'id', 'transfer_number', 'approved_at', 'received_at',
            'created_at', 'updated_at',
        ]


# ---------------------------------------------------------------------------
# Recipe
# ---------------------------------------------------------------------------

class RecipeIngredientSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)
    unit_name = serializers.CharField(source='unit.short_name', read_only=True)

    class Meta:
        model = RecipeIngredient
        fields = [
            'id', 'recipe', 'ingredient', 'ingredient_name',
            'quantity', 'unit', 'unit_name',
        ]
        read_only_fields = ['id']


class RecipeSerializer(serializers.ModelSerializer):
    ingredients = RecipeIngredientSerializer(many=True, read_only=True)
    menu_item_name = serializers.CharField(source='menu_item.name', read_only=True)
    variant_name = serializers.CharField(source='variant.name', read_only=True, allow_null=True)

    class Meta:
        model = Recipe
        fields = [
            'id', 'menu_item', 'menu_item_name', 'variant', 'variant_name',
            'name', 'ingredients', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'name', 'created_at', 'updated_at']
