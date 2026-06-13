from django.contrib import admin

from menu.models import (
    DietaryTag,
    MenuCategory,
    MenuItem,
    MenuVersion,
    ModifierGroup,
    PrinterStation,
    Variant,
)


@admin.register(MenuCategory)
class MenuCategoryAdmin(admin.ModelAdmin):
    list_display = ['name', 'location', 'display_order', 'is_active']
    list_select_related = ['location']


class VariantInline(admin.TabularInline):
    model = Variant
    extra = 0


class ModifierGroupInline(admin.TabularInline):
    model = ModifierGroup
    extra = 0


@admin.register(MenuItem)
class MenuItemAdmin(admin.ModelAdmin):
    list_display = ['name', 'category', 'base_price', 'station', 'is_available']
    list_filter = ['category__location', 'is_available', 'station']
    inlines = [VariantInline, ModifierGroupInline]
    list_select_related = ['category', 'station']


@admin.register(PrinterStation)
class PrinterStationAdmin(admin.ModelAdmin):
    list_display = ['name', 'code', 'location']
    list_select_related = ['location']


admin.site.register(DietaryTag)
admin.site.register(MenuVersion)
