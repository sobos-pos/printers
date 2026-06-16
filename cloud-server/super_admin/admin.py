from django.contrib import admin
from super_admin.models import StaffInvitation


@admin.register(StaffInvitation)
class StaffInvitationAdmin(admin.ModelAdmin):
    list_display = ['user', 'location', 'restaurant', 'is_accepted', 'expires_at', 'created_at']
    list_select_related = ['user', 'location', 'restaurant']
