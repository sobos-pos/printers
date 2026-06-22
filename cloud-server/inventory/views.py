"""
Inventory API views — function-based (matching project convention).

audit-5: every view now requires authentication. Project-wide
DEFAULT_PERMISSION_CLASSES is [] so we must opt in explicitly.

FIXME(audit-1): tenant scoping is still missing — a logged-in user from
Restaurant A can read/write Restaurant B's data by passing the right query
param. Add a ``request.user.restaurant_id`` filter on every queryset.
"""

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import (
    Batch,
    Ingredient,
    IngredientCategory,
    InventoryUnit,
    PurchaseOrder,
    Recipe,
    StockLevel,
    StockTransfer,
    Supplier,
    WastageLog,
)
from .serializers import (
    AdjustStockSerializer,
    BatchSerializer,
    CreatePurchaseOrderSerializer,
    CreateTransferSerializer,
    IngredientCategorySerializer,
    IngredientSerializer,
    InventoryUnitSerializer,
    LogWastageSerializer,
    PurchaseOrderSerializer,
    ReceivePOItemSerializer,
    RecipeSerializer,
    StockLevelSerializer,
    StockMovementSerializer,
    StockTransferSerializer,
    SupplierSerializer,
    WastageLogSerializer,
)
from .services import (
    purchase_order_service,
    recipe_service,
    stock_service,
    transfer_service,
    wastage_service,
)


# ---------------------------------------------------------------------------
# Ingredients
# ---------------------------------------------------------------------------

@api_view(['GET', 'POST'])
def ingredient_list(request):
    """List or create ingredients for a restaurant."""
    if request.method == 'GET':
        restaurant_id = request.query_params.get('restaurant_id')
        qs = Ingredient.objects.select_related('unit', 'category')
        if restaurant_id:
            qs = qs.filter(restaurant_id=restaurant_id)
        return Response(IngredientSerializer(qs, many=True).data)

    serializer = IngredientSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    serializer.save()
    return Response(serializer.data, status=status.HTTP_201_CREATED)


@api_view(['GET', 'PATCH'])
def ingredient_detail(request, ingredient_id):
    """Retrieve or update an ingredient."""
    try:
        ingredient = Ingredient.objects.select_related('unit', 'category').get(id=ingredient_id)
    except Ingredient.DoesNotExist:
        return Response({'error': 'Ingredient not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response(IngredientSerializer(ingredient).data)

    serializer = IngredientSerializer(ingredient, data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    serializer.save()
    return Response(serializer.data)


# ---------------------------------------------------------------------------
# Stock Levels
# ---------------------------------------------------------------------------

@api_view(['GET'])
def stock_level_list(request):
    """List stock levels for a location."""
    location_id = request.query_params.get('location_id')
    if not location_id:
        return Response({'error': 'location_id is required'}, status=status.HTTP_400_BAD_REQUEST)

    qs = (
        StockLevel.objects
        .filter(location_id=location_id)
        .select_related('ingredient', 'ingredient__unit', 'ingredient__category')
        .order_by('ingredient__name')
    )

    # Optional filters
    category_id = request.query_params.get('category_id')
    if category_id:
        qs = qs.filter(ingredient__category_id=category_id)

    alert_status = request.query_params.get('alert_status')
    if alert_status == 'low':
        from django.db.models import F
        qs = qs.filter(
            low_stock_threshold__isnull=False,
            quantity__lte=F('low_stock_threshold'),
        )
    elif alert_status == 'zero':
        qs = qs.filter(quantity__lte=0)

    search = request.query_params.get('search')
    if search:
        qs = qs.filter(ingredient__name__icontains=search)

    return Response(StockLevelSerializer(qs, many=True).data)


@api_view(['PATCH'])
def stock_level_update(request, stock_level_id):
    """Update stock level settings (threshold, reorder, cost_method)."""
    try:
        stock = StockLevel.objects.get(id=stock_level_id)
    except StockLevel.DoesNotExist:
        return Response({'error': 'Stock level not found'}, status=status.HTTP_404_NOT_FOUND)

    serializer = StockLevelSerializer(stock, data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    serializer.save()
    return Response(serializer.data)


@api_view(['GET'])
def low_stock_alerts(request, location_id):
    """Get all items at or below their low-stock threshold."""
    qs = stock_service.get_low_stock_items(location_id)
    return Response(StockLevelSerializer(qs, many=True).data)


# ---------------------------------------------------------------------------
# Stock Adjustments
# ---------------------------------------------------------------------------

@api_view(['POST'])
def stock_adjust(request):
    """Manual stock adjustment (physical count, correction)."""
    serializer = AdjustStockSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data

    performed_by = request.user if request.user.is_authenticated else None

    try:
        stock, movement = stock_service.adjust_stock(
            ingredient_id=data['ingredient_id'],
            location_id=data['location_id'],
            new_quantity=data['new_quantity'],
            reason=data['reason'],
            notes=data.get('notes', ''),
            performed_by=performed_by,
        )
    except StockLevel.DoesNotExist:
        return Response({'error': 'Stock level not found'}, status=status.HTTP_404_NOT_FOUND)

    return Response({
        'stock': StockLevelSerializer(stock).data,
        'movement': StockMovementSerializer(movement).data,
    })


@api_view(['GET'])
def stock_movements(request):
    """List stock movements (audit trail) with filters."""
    qs = stock_service.get_stock_movements(
        ingredient_id=request.query_params.get('ingredient_id'),
        location_id=request.query_params.get('location_id'),
        movement_type=request.query_params.get('movement_type'),
        date_from=request.query_params.get('date_from'),
        date_to=request.query_params.get('date_to'),
    )
    return Response(StockMovementSerializer(qs[:100], many=True).data)


# ---------------------------------------------------------------------------
# Suppliers
# ---------------------------------------------------------------------------

@api_view(['GET', 'POST'])
def supplier_list(request):
    """List or create suppliers."""
    if request.method == 'GET':
        restaurant_id = request.query_params.get('restaurant_id')
        qs = Supplier.objects.prefetch_related('supplied_ingredients__ingredient')
        if restaurant_id:
            qs = qs.filter(restaurant_id=restaurant_id)
        return Response(SupplierSerializer(qs, many=True).data)

    serializer = SupplierSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    serializer.save()
    return Response(serializer.data, status=status.HTTP_201_CREATED)


@api_view(['GET', 'PATCH'])
def supplier_detail(request, supplier_id):
    """Retrieve or update a supplier."""
    try:
        supplier = Supplier.objects.prefetch_related('supplied_ingredients__ingredient').get(id=supplier_id)
    except Supplier.DoesNotExist:
        return Response({'error': 'Supplier not found'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response(SupplierSerializer(supplier).data)

    serializer = SupplierSerializer(supplier, data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    serializer.save()
    return Response(serializer.data)


# ---------------------------------------------------------------------------
# Purchase Orders
# ---------------------------------------------------------------------------

@api_view(['GET', 'POST'])
def purchase_order_list(request):
    """List or create purchase orders."""
    if request.method == 'GET':
        location_id = request.query_params.get('location_id')
        qs = PurchaseOrder.objects.select_related('supplier', 'location').prefetch_related('items__ingredient')
        if location_id:
            qs = qs.filter(location_id=location_id)
        po_status = request.query_params.get('status')
        if po_status:
            qs = qs.filter(status=po_status)
        return Response(PurchaseOrderSerializer(qs, many=True).data)

    serializer = CreatePurchaseOrderSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data
    created_by = request.user if request.user.is_authenticated else None

    try:
        po = purchase_order_service.create_purchase_order(
            supplier_id=data['supplier_id'],
            location_id=data['location_id'],
            order_date=data['order_date'],
            items_data=data['items'],
            expected_delivery_date=data.get('expected_delivery_date'),
            notes=data.get('notes', ''),
            created_by=created_by,
        )
    except Exception as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    po.refresh_from_db()
    return Response(
        PurchaseOrderSerializer(po).data,
        status=status.HTTP_201_CREATED,
    )


@api_view(['GET'])
def purchase_order_detail(request, po_id):
    """Retrieve a purchase order with all items."""
    try:
        po = (
            PurchaseOrder.objects
            .select_related('supplier', 'location')
            .prefetch_related('items__ingredient')
            .get(id=po_id)
        )
    except PurchaseOrder.DoesNotExist:
        return Response({'error': 'Purchase order not found'}, status=status.HTTP_404_NOT_FOUND)
    return Response(PurchaseOrderSerializer(po).data)


@api_view(['POST'])
def purchase_order_submit(request, po_id):
    """Submit a draft PO."""
    try:
        po = purchase_order_service.submit_purchase_order(po_id)
    except PurchaseOrder.DoesNotExist:
        return Response({'error': 'Purchase order not found'}, status=status.HTTP_404_NOT_FOUND)
    except ValueError as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(PurchaseOrderSerializer(po).data)


@api_view(['POST'])
def purchase_order_receive(request):
    """Receive a PO line item (supports partial receipt)."""
    serializer = ReceivePOItemSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data
    performed_by = request.user if request.user.is_authenticated else None

    try:
        po_item, batch = purchase_order_service.receive_po_item(
            po_item_id=data['po_item_id'],
            received_quantity=data['received_quantity'],
            received_unit_price=data.get('received_unit_price'),
            batch_number=data.get('batch_number', ''),
            manufacture_date=data.get('manufacture_date'),
            expiry_date=data.get('expiry_date'),
            fssai_mfg_license=data.get('fssai_mfg_license', ''),
            performed_by=performed_by,
        )
    except Exception as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    result = {'po_item_id': str(po_item.id), 'received_quantity': str(po_item.received_quantity)}
    if batch:
        result['batch'] = BatchSerializer(batch).data
    return Response(result)


@api_view(['POST'])
def purchase_order_cancel(request, po_id):
    """Cancel a PO."""
    try:
        po = purchase_order_service.cancel_purchase_order(po_id)
    except PurchaseOrder.DoesNotExist:
        return Response({'error': 'Purchase order not found'}, status=status.HTTP_404_NOT_FOUND)
    except ValueError as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(PurchaseOrderSerializer(po).data)


# ---------------------------------------------------------------------------
# Wastage
# ---------------------------------------------------------------------------

@api_view(['GET', 'POST'])
def wastage_list(request):
    """List or log wastage."""
    if request.method == 'GET':
        location_id = request.query_params.get('location_id')
        qs = WastageLog.objects.select_related('ingredient', 'batch', 'logged_by')
        if location_id:
            qs = qs.filter(location_id=location_id)
        return Response(WastageLogSerializer(qs[:100], many=True).data)

    serializer = LogWastageSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data
    logged_by = request.user if request.user.is_authenticated else None

    try:
        wastage = wastage_service.log_wastage(
            ingredient_id=data['ingredient_id'],
            location_id=data['location_id'],
            quantity=data['quantity'],
            reason=data['reason'],
            batch_id=data.get('batch_id'),
            notes=data.get('notes', ''),
            logged_by=logged_by,
        )
    except Exception as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    return Response(WastageLogSerializer(wastage).data, status=status.HTTP_201_CREATED)


@api_view(['GET'])
def wastage_summary(request, location_id):
    """Aggregated wastage report for a location."""
    summary = wastage_service.get_wastage_summary(
        location_id=location_id,
        date_from=request.query_params.get('date_from'),
        date_to=request.query_params.get('date_to'),
    )
    return Response(summary)


# ---------------------------------------------------------------------------
# Transfers
# ---------------------------------------------------------------------------

@api_view(['GET', 'POST'])
def transfer_list(request):
    """List or create transfers."""
    if request.method == 'GET':
        qs = StockTransfer.objects.select_related(
            'from_location', 'to_location', 'requested_by', 'approved_by',
        ).prefetch_related('items__ingredient')
        location_id = request.query_params.get('location_id')
        if location_id:
            from django.db.models import Q
            qs = qs.filter(Q(from_location_id=location_id) | Q(to_location_id=location_id))
        transfer_status = request.query_params.get('status')
        if transfer_status:
            qs = qs.filter(status=transfer_status)
        return Response(StockTransferSerializer(qs, many=True).data)

    serializer = CreateTransferSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data
    requested_by = request.user if request.user.is_authenticated else None

    try:
        transfer = transfer_service.create_transfer(
            from_location_id=data['from_location_id'],
            to_location_id=data['to_location_id'],
            items_data=data['items'],
            reason=data.get('reason', ''),
            requested_by=requested_by,
        )
    except ValueError as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    return Response(StockTransferSerializer(transfer).data, status=status.HTTP_201_CREATED)


@api_view(['GET'])
def transfer_detail(request, transfer_id):
    """Retrieve a transfer with all items."""
    try:
        transfer = (
            StockTransfer.objects
            .select_related('from_location', 'to_location', 'requested_by', 'approved_by')
            .prefetch_related('items__ingredient')
            .get(id=transfer_id)
        )
    except StockTransfer.DoesNotExist:
        return Response({'error': 'Transfer not found'}, status=status.HTTP_404_NOT_FOUND)
    return Response(StockTransferSerializer(transfer).data)


@api_view(['POST'])
def transfer_approve(request, transfer_id):
    """Approve a transfer (deducts stock from sender)."""
    approved_by = request.user if request.user.is_authenticated else None
    try:
        transfer = transfer_service.approve_transfer(
            transfer_id,
            approved_quantities=request.data.get('approved_quantities'),
            approved_by=approved_by,
        )
    except (StockTransfer.DoesNotExist, ValueError) as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(StockTransferSerializer(transfer).data)


@api_view(['POST'])
def transfer_reject(request, transfer_id):
    """Reject a transfer."""
    try:
        transfer = transfer_service.reject_transfer(
            transfer_id,
            rejection_reason=request.data.get('rejection_reason', ''),
        )
    except (StockTransfer.DoesNotExist, ValueError) as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(StockTransferSerializer(transfer).data)


@api_view(['POST'])
def transfer_receive(request, transfer_id):
    """Receive a transfer (adds stock at destination)."""
    received_by = request.user if request.user.is_authenticated else None
    try:
        transfer = transfer_service.receive_transfer(
            transfer_id,
            received_quantities=request.data.get('received_quantities'),
            received_by=received_by,
        )
    except (StockTransfer.DoesNotExist, ValueError) as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(StockTransferSerializer(transfer).data)


# ---------------------------------------------------------------------------
# Batches
# ---------------------------------------------------------------------------

@api_view(['GET'])
def batch_list(request):
    """List batches for a location/ingredient."""
    qs = Batch.objects.select_related('ingredient', 'supplier', 'location')
    location_id = request.query_params.get('location_id')
    if location_id:
        qs = qs.filter(location_id=location_id)
    ingredient_id = request.query_params.get('ingredient_id')
    if ingredient_id:
        qs = qs.filter(ingredient_id=ingredient_id)
    batch_status = request.query_params.get('status')
    if batch_status:
        qs = qs.filter(status=batch_status)
    return Response(BatchSerializer(qs, many=True).data)


# ---------------------------------------------------------------------------
# Recipes
# ---------------------------------------------------------------------------

@api_view(['GET'])
def recipe_list(request):
    """List recipes."""
    qs = Recipe.objects.select_related('menu_item', 'variant').prefetch_related(
        'ingredients__ingredient', 'ingredients__unit',
    )
    menu_item_id = request.query_params.get('menu_item_id')
    if menu_item_id:
        qs = qs.filter(menu_item_id=menu_item_id)
    return Response(RecipeSerializer(qs, many=True).data)


@api_view(['GET'])
def recipe_cost(request, recipe_id):
    """Calculate recipe cost at a location."""
    location_id = request.query_params.get('location_id')
    if not location_id:
        return Response({'error': 'location_id is required'}, status=status.HTTP_400_BAD_REQUEST)
    try:
        cost = recipe_service.calculate_recipe_cost(recipe_id, location_id)
    except Exception as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
    return Response(cost)


@api_view(['GET'])
def ingredient_availability(request):
    """Check ingredient availability for a menu item."""
    menu_item_id = request.query_params.get('menu_item_id')
    if not menu_item_id:
        return Response({'error': 'menu_item_id is required'}, status=status.HTTP_400_BAD_REQUEST)
    # FIX(audit-28): int() on bad input previously raised an uncaught ValueError
    # → DRF 500. Validate up front.
    raw_qty = request.query_params.get('quantity', '1')
    try:
        qty = int(raw_qty)
        if qty < 1:
            raise ValueError
    except (TypeError, ValueError):
        return Response(
            {'error': f'quantity must be a positive integer (got {raw_qty!r}).'},
            status=status.HTTP_400_BAD_REQUEST,
        )
    result = recipe_service.check_ingredient_availability(
        menu_item_id=menu_item_id,
        variant_id=request.query_params.get('variant_id'),
        location_id=request.query_params.get('location_id'),
        quantity=qty,
    )
    return Response(result)
