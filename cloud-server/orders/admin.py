from django.contrib import admin

from orders.models import Order, OrderItem


class OrderItemInline(admin.TabularInline):
    model = OrderItem
    extra = 0


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ['id', 'table', 'source', 'status', 'total', 'created_at']
    list_filter = ['source', 'status', 'location']
    inlines = [OrderItemInline]
    list_select_related = ['table', 'location']
