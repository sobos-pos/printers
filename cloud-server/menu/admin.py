from django.contrib import admin

from menu.models import (
    Allergen,
    Charge,
    MeatType,
    MenuCategory,
    MenuItem,
    MenuItemMedia,
    MenuSubCategory,
    MenuVersion,
    ModerationRecord,
    Modifier,
    ModifierGroup,
    PreparationTime,
    PrinterStation,
    ServingInfo,
    Tag,
    Tax,
    TaxGroup,
    TaxGroupTax,
    Unit,
    Variant,
    VariantCharge,
)


# --- Glossary / reference data ---------------------------------------------

class TaxGroupTaxInline(admin.TabularInline):
    model = TaxGroupTax
    extra = 0


@admin.register(TaxGroup)
class TaxGroupAdmin(admin.ModelAdmin):
    list_display = ['slug', 'name', 'calc_type', 'rate', 'service', 'is_active']
    search_fields = ['slug', 'name']
    inlines = [TaxGroupTaxInline]


@admin.register(Tax)
class TaxAdmin(admin.ModelAdmin):
    list_display = ['slug', 'name', 'display_name', 'rate', 'service', 'is_active']
    search_fields = ['slug', 'name']


@admin.register(Charge)
class ChargeAdmin(admin.ModelAdmin):
    list_display = ['slug', 'name', 'calc_type', 'service', 'is_active']
    search_fields = ['slug', 'name']


@admin.register(Tag)
class TagAdmin(admin.ModelAdmin):
    list_display = ['slug', 'name', 'tag_type', 'selection', 'is_active']
    list_filter = ['tag_type', 'selection', 'is_active']
    search_fields = ['slug', 'name']


for _model in (Unit, PreparationTime, ServingInfo, MeatType, Allergen):
    admin.site.register(_model)


# --- Menu structure ---------------------------------------------------------

class MenuSubCategoryInline(admin.TabularInline):
    model = MenuSubCategory
    extra = 0


@admin.register(MenuCategory)
class MenuCategoryAdmin(admin.ModelAdmin):
    list_display = ['name', 'location', 'display_order', 'is_active']
    list_select_related = ['location']
    inlines = [MenuSubCategoryInline]


class VariantChargeInline(admin.TabularInline):
    model = VariantCharge
    extra = 0


@admin.register(Variant)
class VariantAdmin(admin.ModelAdmin):
    list_display = ['name', 'menu_item', 'price', 'tax_group', 'is_available']
    list_select_related = ['menu_item', 'tax_group']
    inlines = [VariantChargeInline]


class VariantInline(admin.TabularInline):
    model = Variant
    extra = 0
    show_change_link = True


class ModifierGroupInline(admin.TabularInline):
    model = ModifierGroup
    fk_name = 'menu_item'
    extra = 0
    show_change_link = True


class MenuItemMediaInline(admin.TabularInline):
    model = MenuItemMedia
    extra = 0


@admin.register(MenuItem)
class MenuItemAdmin(admin.ModelAdmin):
    list_display = ['name', 'category', 'subcategory', 'kind', 'station', 'is_available']
    list_filter = ['category__location', 'kind', 'is_available', 'station']
    search_fields = ['name']
    filter_horizontal = ['tags', 'meat_types', 'allergens']
    inlines = [VariantInline, ModifierGroupInline, MenuItemMediaInline]
    list_select_related = ['category', 'subcategory', 'station']


class ModifierInline(admin.TabularInline):
    model = Modifier
    extra = 0
    show_change_link = True


@admin.register(ModifierGroup)
class ModifierGroupAdmin(admin.ModelAdmin):
    list_display = ['name', 'menu_item', 'parent_option', 'min_selection', 'max_selection', 'required']
    inlines = [ModifierInline]


@admin.register(PrinterStation)
class PrinterStationAdmin(admin.ModelAdmin):
    list_display = ['name', 'code', 'location']
    list_select_related = ['location']


# --- Operations -------------------------------------------------------------

@admin.register(ModerationRecord)
class ModerationRecordAdmin(admin.ModelAdmin):
    list_display = ['entity_type', 'status', 'entity_id', 'meta_key', 'location', 'reviewed_at']
    list_filter = ['entity_type', 'status']
    search_fields = ['entity_id', 'external_ref']
    list_select_related = ['location']


admin.site.register(MenuVersion)
