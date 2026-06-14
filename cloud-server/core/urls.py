from django.urls import path

from core.views import (
    SyncActiveStatusView,
    SyncClaimActiveView,
    SyncClusterStateView,
    SyncHeartbeatView,
    SyncMenuView,
    SyncNodeConfigView,
    SyncNodeOfflineView,
    SyncOrderStatusView,
    SyncOrdersAckView,
    SyncOrdersBulkView,
    SyncOrdersPollView,
    SyncNodesView,
    SyncNodesCreateView,
    SyncPrintRoutesView,
)

urlpatterns = [
    path('orders/', SyncOrdersPollView.as_view()),
    path('orders/ack/', SyncOrdersAckView.as_view()),
    path('orders/<uuid:order_uuid>/status/', SyncOrderStatusView.as_view()),
    path('orders/bulk/', SyncOrdersBulkView.as_view()),
    path('heartbeat/', SyncHeartbeatView.as_view()),
    path('cluster-state/', SyncClusterStateView.as_view()),
    path('menu/', SyncMenuView.as_view()),
    path('active-status/', SyncActiveStatusView.as_view()),
    path('claim-active/', SyncClaimActiveView.as_view()),
    path('node-config/', SyncNodeConfigView.as_view()),
    path('node-offline/', SyncNodeOfflineView.as_view()),
    path('nodes/', SyncNodesView.as_view()),
    path('nodes/create/', SyncNodesCreateView.as_view()),
    path('print-routes/', SyncPrintRoutesView.as_view()),
]
