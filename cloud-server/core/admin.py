from django.contrib import admin

from core.models import Location, LocationNode, NodeConfig, Restaurant, StaffAttendance, SyncLog, SyncOutbox, StaffUser, LocationLease
from django.contrib.auth.admin import UserAdmin


@admin.register(Restaurant)
class RestaurantAdmin(admin.ModelAdmin):
    list_display = ['name', 'is_active', 'created_at']


@admin.register(Location)
class LocationAdmin(admin.ModelAdmin):
    list_display = ['name', 'restaurant', 'is_active', 'latitude', 'longitude', 'geofence_radius_m']
    list_select_related = ['restaurant']
    fields = [
        'restaurant', 'name', 'address', 'timezone', 'is_active',
        'latitude', 'longitude', 'geofence_radius_m',
    ]


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
    list_display = ['username', 'email', 'restaurant', 'location', 'role', 'is_staff']
    fieldsets = UserAdmin.fieldsets + (
        ('Restaurant Details', {'fields': ('restaurant', 'location', 'role')}),
    )


@admin.register(StaffAttendance)
class StaffAttendanceAdmin(admin.ModelAdmin):
    list_display = [
        'staff_user', 'location', 'clock_in_at', 'clock_out_at',
        'clock_in_distance_m', 'clock_out_distance_m',
    ]
    list_select_related = ['staff_user', 'location']
    readonly_fields = [
        'staff_user', 'location', 'clock_in_at', 'clock_out_at',
        'clock_in_lat', 'clock_in_lng', 'clock_in_distance_m',
        'clock_out_lat', 'clock_out_lng', 'clock_out_distance_m',
        'created_at', 'updated_at',
    ]
    ordering = ['-clock_in_at']


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
