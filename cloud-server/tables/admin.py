from django.contrib import admin

from tables.models import Table


@admin.register(Table)
class TableAdmin(admin.ModelAdmin):
    list_display = ['label', 'location', 'is_active']
    list_select_related = ['location']
