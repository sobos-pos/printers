from django.contrib import admin

from orders.models import Order, OrderItem


class OrderItemInline(admin.TabularInline):
    model = OrderItem
    extra = 0


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ['id', 'table', 'source', 'status', 'total', 'created_by', 'created_at']
    list_filter = ['source', 'status', 'location', 'created_by']
    inlines = [OrderItemInline]
    list_select_related = ['table', 'location', 'created_by']
    search_fields = ['created_by__username', 'table__label']
    readonly_fields = ['created_at', 'updated_at']
