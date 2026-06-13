from django.contrib import admin

from core.models import Location, LocationNode, NodeConfig, Restaurant, SyncLog, SyncOutbox, StaffUser, LocationLease
from django.contrib.auth.admin import UserAdmin


@admin.register(Restaurant)
class RestaurantAdmin(admin.ModelAdmin):
    list_display = ['name', 'is_active', 'created_at']


@admin.register(Location)
class LocationAdmin(admin.ModelAdmin):
    list_display = ['name', 'restaurant', 'is_active']
    list_select_related = ['restaurant']


@admin.register(LocationNode)
class LocationNodeAdmin(admin.ModelAdmin):
    list_display = ['location', 'node_id', 'node_label', 'cluster_role', 'is_online', 'last_heartbeat_at']
    readonly_fields = ['api_key_hash', 'last_heartbeat_at']
    list_select_related = ['location']


@admin.register(LocationLease)
class LocationLeaseAdmin(admin.ModelAdmin):
    list_display = ['location', 'active_holder', 'active_lease_expires_at']
    list_select_related = ['location']


@admin.register(StaffUser)
class StaffUserAdmin(UserAdmin):
    list_display = ['username', 'email', 'restaurant', 'role', 'is_staff']
    fieldsets = UserAdmin.fieldsets + (
        ('Restaurant Details', {'fields': ('restaurant', 'role')}),
    )


@admin.register(SyncOutbox)
class SyncOutboxAdmin(admin.ModelAdmin):
    list_display = ['sequence', 'event_type', 'location', 'acked_at', 'created_at']
    list_filter = ['event_type', 'location']
    readonly_fields = ['sequence', 'payload']
    list_select_related = ['location']


@admin.register(SyncLog)
class SyncLogAdmin(admin.ModelAdmin):
    list_display = ['sync_type', 'direction', 'status', 'attempt_count', 'created_at']
    list_filter = ['sync_type', 'status']


@admin.register(NodeConfig)
class NodeConfigAdmin(admin.ModelAdmin):
    list_display = ['location', 'node_id', 'updated_at']
    list_select_related = ['location']
