from django.urls import path
from . import views

urlpatterns = [
    # --- Ingredients ---
    path('ingredients/', views.ingredient_list, name='ingredient-list'),
    path('ingredients/<uuid:ingredient_id>/', views.ingredient_detail, name='ingredient-detail'),

    # --- Stock Levels ---
    path('stock/', views.stock_level_list, name='stock-level-list'),
    path('stock/<uuid:stock_level_id>/', views.stock_level_update, name='stock-level-update'),
    path('stock/adjust/', views.stock_adjust, name='stock-adjust'),
    path('stock/movements/', views.stock_movements, name='stock-movements'),
    path('stock/low-alerts/<uuid:location_id>/', views.low_stock_alerts, name='low-stock-alerts'),

    # --- Suppliers ---
    path('suppliers/', views.supplier_list, name='supplier-list'),
    path('suppliers/<uuid:supplier_id>/', views.supplier_detail, name='supplier-detail'),

    # --- Purchase Orders ---
    path('purchase-orders/', views.purchase_order_list, name='purchase-order-list'),
    path('purchase-orders/<uuid:po_id>/', views.purchase_order_detail, name='purchase-order-detail'),
    path('purchase-orders/<uuid:po_id>/submit/', views.purchase_order_submit, name='purchase-order-submit'),
    path('purchase-orders/<uuid:po_id>/cancel/', views.purchase_order_cancel, name='purchase-order-cancel'),
    path('purchase-orders/receive/', views.purchase_order_receive, name='purchase-order-receive'),

    # --- Wastage ---
    path('wastage/', views.wastage_list, name='wastage-list'),
    path('wastage/summary/<uuid:location_id>/', views.wastage_summary, name='wastage-summary'),

    # --- Transfers ---
    path('transfers/', views.transfer_list, name='transfer-list'),
    path('transfers/<uuid:transfer_id>/', views.transfer_detail, name='transfer-detail'),
    path('transfers/<uuid:transfer_id>/approve/', views.transfer_approve, name='transfer-approve'),
    path('transfers/<uuid:transfer_id>/reject/', views.transfer_reject, name='transfer-reject'),
    path('transfers/<uuid:transfer_id>/receive/', views.transfer_receive, name='transfer-receive'),

    # --- Batches ---
    path('batches/', views.batch_list, name='batch-list'),

    # --- Recipes ---
    path('recipes/', views.recipe_list, name='recipe-list'),
    path('recipes/<uuid:recipe_id>/cost/', views.recipe_cost, name='recipe-cost'),
    path('recipes/availability/', views.ingredient_availability, name='ingredient-availability'),
]
