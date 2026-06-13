from django.urls import path

from orders.views import OrderCreateView, OrderDetailView, OrderKOTView

urlpatterns = [
    path('orders/', OrderCreateView.as_view()),
    path('orders/<uuid:order_uuid>/', OrderDetailView.as_view()),
    path('orders/<uuid:order_uuid>/kot/', OrderKOTView.as_view()),
]
