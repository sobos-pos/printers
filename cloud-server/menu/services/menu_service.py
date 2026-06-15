from django.db import transaction
from django.db.models import Prefetch

from core.models import SyncOutbox
from menu.models import MenuCategory, MenuItem, MenuVersion, Modifier
from tables.models import Table


class MenuService:

    _ITEM_PREFETCH = Prefetch(
        'items',
        queryset=MenuItem.objects.filter(is_available=True)
        .select_related('station')
        .prefetch_related(
            'variants',
            Prefetch(
                'modifier_groups__options',
                queryset=Modifier.objects.filter(is_available=True),
            ),
            'dietary_tags',
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
            .prefetch_related(MenuService._ITEM_PREFETCH)
            .order_by('display_order')
        )

        return {
            'table': {'id': str(table.id), 'label': table.label},
            'menu_version': menu_version.version,
            'categories': MenuService._serialize_categories(categories),
        }

    @staticmethod
    def _serialize_categories(categories):
        result = []
        for cat in categories:
            items = []
            for item in cat.items.all():
                items.append({
                    'id': str(item.id),
                    'name': item.name,
                    'description': item.description,
                    'base_price': str(item.base_price),
                    'is_available': item.is_available,
                    'station': {
                        'code': item.station.code,
                        'name': item.station.name,
                    }
                    if item.station
                    else None,
                    'image': item.image.url if item.image else None,
                    'dietary_tags': [
                        {'label': t.label, 'icon': t.icon} for t in item.dietary_tags.all()
                    ],
                    'variants': [
                        {
                            'id': str(v.id),
                            'name': v.name,
                            'price_delta': str(v.price_delta),
                        }
                        for v in item.variants.all()
                    ],
                    'modifier_groups': [
                        {
                            'id': str(g.id),
                            'name': g.name,
                            'min_select': g.min_select,
                            'max_select': g.max_select,
                            'options': [
                                {
                                    'id': str(o.id),
                                    'name': o.name,
                                    'price_delta': str(o.price_delta),
                                    'is_available': o.is_available,
                                }
                                for o in g.options.all()
                            ],
                        }
                        for g in item.modifier_groups.all()
                    ],
                })
            result.append({
                'id': str(cat.id),
                'name': cat.name,
                'display_order': cat.display_order,
                'items': items,
            })
        return result

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
            .prefetch_related(MenuService._ITEM_PREFETCH)
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
