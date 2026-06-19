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

    # Top-level modifier groups (menu_item set) and their in-stock options.
    # Nested groups are prefetched a few levels deep; the recursive serializer
    # handles any remaining depth lazily.
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
        .select_related('station', 'preparation_time', 'serving_info', 'subcategory')
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
        """Resolve table -> location -> build the full rich menu payload."""
        table = Table.objects.select_related('location').get(
            id=table_uuid, is_active=True
        )
        location = table.location
        menu_version, _ = MenuVersion.objects.get_or_create(location=location)

        categories = (
            MenuCategory.objects.filter(location=location, is_active=True)
            .prefetch_related('subcategories', MenuService._ITEM_PREFETCH)
            .order_by('display_order')
        )

        return {
            'table': {'id': str(table.id), 'label': table.label},
            'menu_version': menu_version.version,
            'categories': MenuService._serialize_categories(categories),
        }

    # -- serialization ------------------------------------------------------

    @staticmethod
    def _serialize_categories(categories):
        result = []
        for cat in categories:
            result.append({
                'id': str(cat.id),
                'name': cat.name,
                'description': cat.description,
                'display_order': cat.display_order,
                'image': cat.image.url if cat.image else None,
                'subcategories': [
                    {
                        'id': str(sub.id),
                        'name': sub.name,
                        'display_order': sub.display_order,
                    }
                    for sub in cat.subcategories.all()
                    if sub.is_active
                ],
                'items': [MenuService._serialize_item(item) for item in cat.items.all()],
            })
        return result

    @staticmethod
    def _serialize_item(item) -> dict:
        variants = list(item.variants.all())
        # base_price = cheapest available variant; convenience for clients that
        # display a "from" price or do not force variant selection.
        base_price = str(min((v.price for v in variants), default=0))
        return {
            'id': str(item.id),
            'name': item.name,
            'description': item.description,
            'kind': item.kind,
            'subcategory_id': str(item.subcategory_id) if item.subcategory_id else None,
            'is_available': item.is_available,
            'base_price': base_price,
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
        """Return a menu snapshot for the caller.

        A node bootstraps with since_version=0 because it has no cached menu
        yet. A freshly-seeded location also starts at MenuVersion.version == 0,
        so the old "version <= since_version" gate (0 <= 0) meant a brand-new
        node could never receive the menu and its local order validation would
        permanently fail with "Menu item not found".

        Fix: only treat the request as "no changes" when the caller already holds
        a real version (since_version > 0) that is not older than ours. When
        since_version == 0 we always return the full current menu so a node can
        bootstrap regardless of the location's version number.
        """
        menu_version, _ = MenuVersion.objects.get_or_create(location=location)
        if since_version > 0 and menu_version.version <= since_version:
            return None

        categories = (
            MenuCategory.objects.filter(location=location, is_active=True)
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
