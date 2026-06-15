from decimal import Decimal

from django.test import TestCase

from core.models import Location, Restaurant
from menu.models import MenuCategory, MenuItem, MenuVersion
from menu.services.menu_service import MenuService


class MenuSnapshotBoundaryTests(TestCase):
    """Regression tests for the bootstrap boundary bug.

    A fresh node bootstraps with since_version=0 while a freshly-seeded
    location's MenuVersion.version is also 0. The old gate (version <=
    since_version => 0 <= 0) returned None, so the node never cached the menu
    and every local order failed with "Menu item not found".
    """

    def setUp(self):
        self.restaurant = Restaurant.objects.create(name='Biryani Co')
        self.location = Location.objects.create(restaurant=self.restaurant, name='MG Road')
        cat = MenuCategory.objects.create(
            location=self.location, name='Mains', display_order=0
        )
        self.item = MenuItem.objects.create(
            category=cat, name='Margherita Pizza', base_price=Decimal('299.00')
        )

    def _set_version(self, v):
        mv, _ = MenuVersion.objects.get_or_create(location=self.location)
        mv.version = v
        mv.save(update_fields=['version'])

    def test_fresh_node_bootstraps_at_version_zero(self):
        # version 0, node asks since_version=0 -> must get the full menu (the fix)
        self._set_version(0)
        snap = MenuService.get_menu_snapshot(self.location, 0)
        self.assertIsNotNone(snap)
        ids = [i['id'] for c in snap['categories'] for i in c['items']]
        self.assertIn(str(self.item.id), ids)

    def test_up_to_date_node_gets_no_changes(self):
        # node already holds version 3, cloud is at 3 -> no changes
        self._set_version(3)
        self.assertIsNone(MenuService.get_menu_snapshot(self.location, 3))

    def test_stale_node_gets_snapshot(self):
        # node holds version 2, cloud advanced to 3 -> snapshot
        self._set_version(3)
        snap = MenuService.get_menu_snapshot(self.location, 2)
        self.assertIsNotNone(snap)
        self.assertEqual(snap['version'], 3)
