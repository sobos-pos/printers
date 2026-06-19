from decimal import Decimal

from django.db import transaction
from django.db.models import Prefetch

from core.models import SyncOutbox
from menu.models import MenuCategory, MenuItem, MenuVersion, Modifier, Variant
from tables.models import Table


class MenuService:

    # Variants with their tax group, portion unit and packaging charges.
    _VARIANT_PREFETCH = Prefetch(
        'variants',
        queryset=Variant.objects.filter(is_available=True)
        .select_related('tax_group', 'portion_unit')
        .prefetch_related('charges__charge', 'tax_group__taxes')
        .order_by('display_order'),
    )

    # Top-level modifier groups and their in-stock options (prefetched 3 levels deep).
    _MODIFIER_PREFETCH = Prefetch(
        'modifier_groups__options',
        queryset=Modifier.objects.filter(in_stock=True)
        .prefetch_related(
            'nested_groups__options__nested_groups__options',
        )
        .order_by('display_order'),
    )

    _ITEM_PREFETCH = Prefetch(
        'items',
        queryset=MenuItem.objects.filter(is_available=True)
        .select_related('kitchen', 'station', 'preparation_time', 'serving_info', 'subcategory')
        .prefetch_related(
            _VARIANT_PREFETCH,
            _MODIFIER_PREFETCH,
            'tags',
            'meat_types',
            'allergens',
            'media',
        ),
    )

    @staticmethod
    def get_menu_for_table(table_uuid: str) -> dict:
        """Resolve table → section → location → build section-filtered menu payload."""
        table = Table.objects.select_related('location', 'section').get(
            id=table_uuid, is_active=True
        )
        location = table.location
        section = table.section
        menu_version, _ = MenuVersion.objects.get_or_create(location=location)

        # Resolve section-scoped visibility and price overrides.
        price_overrides: dict[str, Decimal] = {}   # item_id (str) → price override
        visible_item_ids: set[str] | None = None    # None = everything is visible

        if section is not None:
            section_menus = list(
                section.section_menus
                .select_related('menu')
                .prefetch_related('menu__listings__item')
            )
            if section_menus:
                # Section has explicit menus → only listed items are visible.
                visible_item_ids = set()
                for sm in section_menus:
                    for listing in sm.menu.listings.all():
                        item_id_str = str(listing.item_id)
                        visible_item_ids.add(item_id_str)
                        if listing.price_override is not None:
                            price_overrides[item_id_str] = listing.price_override

        categories = (
            MenuCategory.objects.filter(location=location, is_active=True)
            .select_related('kitchen')
            .prefetch_related('subcategories', MenuService._ITEM_PREFETCH)
            .order_by('display_order')
        )

        table_info: dict = {'id': str(table.id), 'label': table.label}
        if section is not None:
            table_info['section'] = {'code': section.code, 'name': section.name}

        return {
            'table': table_info,
            'menu_version': menu_version.version,
            'categories': MenuService._serialize_categories(
                categories, visible_item_ids, price_overrides
            ),
        }

    # -- serialization ------------------------------------------------------

    @staticmethod
    def _serialize_categories(
        categories,
        visible_item_ids: set[str] | None = None,
        price_overrides: dict[str, Decimal] | None = None,
    ) -> list:
        price_overrides = price_overrides or {}
        result = []
        for cat in categories:
            category_kitchen_code = cat.kitchen.code if cat.kitchen_id else None
            all_items = cat.items.all()

            if visible_item_ids is not None:
                all_items = [i for i in all_items if str(i.id) in visible_item_ids]
            else:
                all_items = list(all_items)

            # Skip empty categories when section filtering is active.
            if visible_item_ids is not None and not all_items:
                continue

            result.append({
                'id': str(cat.id),
                'name': cat.name,
                'description': cat.description,
                'display_order': cat.display_order,
                'image': cat.image.url if cat.image else None,
                'kitchen_code': category_kitchen_code,
                'subcategories': [
                    {
                        'id': str(sub.id),
                        'name': sub.name,
                        'display_order': sub.display_order,
                    }
                    for sub in cat.subcategories.all()
                    if sub.is_active
                ],
                'items': [
                    MenuService._serialize_item(
                        item,
                        category_kitchen_code=category_kitchen_code,
                        price_override=price_overrides.get(str(item.id)),
                    )
                    for item in all_items
                ],
            })
        return result

    @staticmethod
    def _serialize_item(
        item,
        category_kitchen_code: str | None = None,
        price_override: Decimal | None = None,
    ) -> dict:
        # Resolved kitchen: item > category > None (node falls back to 'KITCHEN')
        kitchen_code = (
            item.kitchen.code if item.kitchen_id else category_kitchen_code
        )

        variants = list(item.variants.all())
        # base_price: use section price_override when set; else cheapest variant.
        if price_override is not None:
            base_price = str(price_override)
        else:
            base_price = str(min((v.price for v in variants), default=0))

        return {
            'id': str(item.id),
            'name': item.name,
            'description': item.description,
            'kind': item.kind,
            'subcategory_id': str(item.subcategory_id) if item.subcategory_id else None,
            'is_available': item.is_available,
            'base_price': base_price,
            'kitchen_code': kitchen_code,
            # Keep station for backward compatibility with older nodes/clients.
            'station': {'code': item.station.code, 'name': item.station.name}
            if item.station
            else None,
            'preparation_time': item.preparation_time.slug if item.preparation_time else None,
            'serving_info': item.serving_info.slug if item.serving_info else None,
            'tags': [t.slug for t in item.tags.all()],
            'meat_types': [m.slug for m in item.meat_types.all()],
            'allergens': [a.slug for a in item.allergens.all()],
            'nutrition': {
                'calorie_count': item.calorie_count,
                'protein_count': str(item.protein_count) if item.protein_count is not None else None,
                'carbohydrate_count': str(item.carbohydrate_count) if item.carbohydrate_count is not None else None,
                'fat_count': str(item.fat_count) if item.fat_count is not None else None,
                'fiber_count': str(item.fiber_count) if item.fiber_count is not None else None,
            },
            'box_metadata': {'rows': item.box_rows, 'columns': item.box_columns}
            if item.box_rows is not None
            else None,
            'media': [m.image.url for m in item.media.all() if m.image],
            'variants': [MenuService._serialize_variant(v) for v in variants],
            'modifier_groups': MenuService._serialize_groups(item.modifier_groups.all()),
        }

    @staticmethod
    def _serialize_variant(v) -> dict:
        return {
            'id': str(v.id),
            'name': v.name,
            'price': str(v.price),
            'tax_group': v.tax_group.slug if v.tax_group else None,
            'taxes': [t.slug for t in v.tax_group.taxes.all()] if v.tax_group else [],
            'portion_size': {
                'value': str(v.portion_value),
                'unit': v.portion_unit.slug if v.portion_unit else None,
            }
            if v.portion_value is not None
            else None,
            'charges': [
                {'slug': c.charge.slug, 'value': str(c.value)} for c in v.charges.all()
            ],
        }

    @staticmethod
    def _serialize_groups(groups) -> list:
        result = []
        for g in groups:
            result.append({
                'id': str(g.id),
                'name': g.name,
                'slug': g.slug,
                'min_selection': g.min_selection,
                'max_selection': g.max_selection,
                'required': g.required,
                'options': [MenuService._serialize_option(o) for o in g.options.all()],
            })
        return result

    @staticmethod
    def _serialize_option(o) -> dict:
        return {
            'id': str(o.id),
            'name': o.name,
            'price': str(o.price),
            'is_default': o.is_default,
            'in_stock': o.in_stock,
            'kind': o.kind or None,
            'nested_option_groups': MenuService._serialize_groups(o.nested_groups.all()),
        }

    @staticmethod
    def get_menu_snapshot(location, since_version: int) -> dict | None:
        """Return a full-location menu snapshot for node sync.

        since_version=0 forces a full pull so a fresh node can bootstrap even
        when the location's menu version is also 0.
        """
        menu_version, _ = MenuVersion.objects.get_or_create(location=location)
        if since_version > 0 and menu_version.version <= since_version:
            return None

        categories = (
            MenuCategory.objects.filter(location=location, is_active=True)
            .select_related('kitchen')
            .prefetch_related('subcategories', MenuService._ITEM_PREFETCH)
            .order_by('display_order')
        )

        return {
            'version': menu_version.version,
            'categories': MenuService._serialize_categories(categories),
        }

    @staticmethod
    @transaction.atomic
    def bump_version(location):
        """Increment MenuVersion and enqueue MENU_UPDATED in SyncOutbox."""
        from core.services.sync_service import SyncService

        mv, _ = MenuVersion.objects.select_for_update().get_or_create(location=location)
        mv.version += 1
        mv.save(update_fields=['version', 'updated_at'])
        SyncService.enqueue(
            location,
            SyncOutbox.EventType.MENU_UPDATED,
            None,
            {'menu_version': mv.version},
        )
