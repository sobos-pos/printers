import json
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.test import Client, TestCase

from core.authentication import ApiKeyAuth
from core.models import Location, Restaurant
from menu.models import (
    Menu,
    MenuCategory,
    MenuItem,
    MenuListing,
    MenuListingVariantPrice,
    MenuVersion,
    SectionMenu,
    Variant,
)
from menu.services.menu_service import MenuService
from tables.models import Section, Table


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
        self.item = MenuItem.objects.create(category=cat, name='Margherita Pizza')
        Variant.objects.create(
            menu_item=self.item, name='Regular', price=Decimal('299.00')
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


class MenuManagementApiTests(TestCase):
    """End-to-end HTTP tests for the menu management API (URL + Api-Key auth +
    nested writes + version bump). Glossary is seeded by migration 0003."""

    def setUp(self):
        self.restaurant = Restaurant.objects.create(name='Spice Co')
        self.location = Location.objects.create(restaurant=self.restaurant, name='HQ')
        self.raw_key = ApiKeyAuth.issue_key(self.location)
        self.client = Client()
        self.headers = {'HTTP_AUTHORIZATION': f'Api-Key {self.raw_key}'}

    def _post(self, path, body):
        return self.client.post(
            path, data=json.dumps(body), content_type='application/json', **self.headers
        )

    def test_requires_auth(self):
        self.assertEqual(self.client.get('/api/v1/menu/glossary/').status_code, 401)

    def test_glossary_returns_seeded_reference_data(self):
        res = self.client.get('/api/v1/menu/glossary/', **self.headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        dietary = [t['slug'] for t in data['tags']['dietary']]
        self.assertEqual(set(dietary), {'veg', 'non-veg', 'egg'})
        self.assertTrue(any(g['slug'] == 'GST_D_P_5.00' for g in data['tax_groups']))

    def test_create_category_then_item_and_version_bumps(self):
        v_start = MenuVersion.objects.get_or_create(location=self.location)[0].version

        cat_res = self._post('/api/v1/menu/categories/', {'name': 'Mains'})
        self.assertEqual(cat_res.status_code, 201)
        category_id = cat_res.json()['id']

        item_res = self._post('/api/v1/menu/items/', {
            'name': 'Butter Chicken',
            'category_id': category_id,
            'tags': ['non-veg', 'goods'],
            'variants': [
                {'name': 'Half', 'price': '250', 'tax_group': 'GST_D_P_5.00'},
                {'name': 'Full', 'price': '450', 'tax_group': 'GST_D_P_5.00'},
            ],
            'modifier_groups': [
                {'name': 'Add-ons', 'min_selection': 0, 'max_selection': 2,
                 'options': [{'name': 'Extra Gravy', 'price': '40'}]},
            ],
        })
        self.assertEqual(item_res.status_code, 201, item_res.content)
        item = MenuItem.objects.get(id=item_res.json()['id'])
        self.assertEqual(item.variants.count(), 2)
        self.assertEqual(item.modifier_groups.first().options.count(), 1)
        self.assertEqual({t.slug for t in item.tags.all()}, {'non-veg', 'goods'})

        v_end = MenuVersion.objects.get(location=self.location).version
        self.assertGreater(v_end, v_start)

    def test_create_item_rejects_two_dietary_tags(self):
        cat_id = self._post('/api/v1/menu/categories/', {'name': 'X'}).json()['id']
        res = self._post('/api/v1/menu/items/', {
            'name': 'Bad', 'category_id': cat_id,
            'tags': ['veg', 'non-veg'],
            'variants': [{'name': 'R', 'price': '1'}],
        })
        self.assertEqual(res.status_code, 400)
        self.assertIn('dietary', res.json()['error'].lower())

    def test_create_item_requires_variant(self):
        cat_id = self._post('/api/v1/menu/categories/', {'name': 'Y'}).json()['id']
        res = self._post('/api/v1/menu/items/', {
            'name': 'NoVariant', 'category_id': cat_id, 'tags': ['veg'], 'variants': [],
        })
        self.assertEqual(res.status_code, 400)

    @staticmethod
    def _png_b64():
        """A real, valid 1x1 PNG so Pillow's verify() accepts it."""
        import base64
        import io

        from PIL import Image

        buf = io.BytesIO()
        Image.new('RGB', (1, 1), (200, 30, 30)).save(buf, format='PNG')
        return base64.b64encode(buf.getvalue()).decode()

    def test_create_item_with_image_and_add_remove_media(self):
        from menu.models import MenuItemMedia

        png_b64 = self._png_b64()

        cat_id = self._post('/api/v1/menu/categories/', {'name': 'Imgs'}).json()['id']
        item_id = self._post('/api/v1/menu/items/', {
            'name': 'Photo Dish', 'category_id': cat_id, 'tags': ['veg'],
            'variants': [{'name': 'R', 'price': '120'}],
            'images': [f'data:image/png;base64,{png_b64}'],
        }).json()['id']
        self.assertEqual(MenuItemMedia.objects.filter(menu_item_id=item_id).count(), 1)
        self.assertTrue(MenuItemMedia.objects.get(menu_item_id=item_id).is_primary)

        # add a second image
        add = self._post(
            f'/api/v1/menu/items/{item_id}/media/', {'image': png_b64}
        )
        self.assertEqual(add.status_code, 201, add.content)
        media_id = add.json()['id']
        self.assertTrue(add.json()['url'].startswith('http'))
        self.assertEqual(MenuItemMedia.objects.filter(menu_item_id=item_id).count(), 2)

        # tree exposes the media with absolute URLs
        tree = self.client.get('/api/v1/menu/tree/', **self.headers).json()
        item = next(i for c in tree['categories'] for i in c['items'] if i['id'] == item_id)
        self.assertEqual(len(item['media']), 2)

        # delete one image
        rm = self.client.delete(f'/api/v1/menu/media/{media_id}/', **self.headers)
        self.assertEqual(rm.status_code, 200)
        self.assertEqual(MenuItemMedia.objects.filter(menu_item_id=item_id).count(), 1)

    def test_reject_non_image_upload(self):
        import base64
        cat_id = self._post('/api/v1/menu/categories/', {'name': 'Bad'}).json()['id']
        not_image = base64.b64encode(b'this is plain text, not an image').decode()
        res = self._post('/api/v1/menu/items/', {
            'name': 'X', 'category_id': cat_id, 'tags': ['veg'],
            'variants': [{'name': 'R', 'price': '1'}], 'images': [not_image],
        })
        self.assertEqual(res.status_code, 400)
        self.assertIn('image', res.json()['error'].lower())

    def test_update_and_delete_item(self):
        cat_id = self._post('/api/v1/menu/categories/', {'name': 'Z'}).json()['id']
        item_id = self._post('/api/v1/menu/items/', {
            'name': 'Toggle Me', 'category_id': cat_id, 'tags': ['veg'],
            'variants': [{'name': 'R', 'price': '99'}],
        }).json()['id']

        patch = self.client.patch(
            f'/api/v1/menu/items/{item_id}/',
            data=json.dumps({'is_available': False}),
            content_type='application/json', **self.headers,
        )
        self.assertEqual(patch.status_code, 200)
        self.assertFalse(MenuItem.objects.get(id=item_id).is_available)

        delete = self.client.delete(f'/api/v1/menu/items/{item_id}/', **self.headers)
        self.assertEqual(delete.status_code, 200)
        self.assertFalse(MenuItem.objects.filter(id=item_id).exists())


class SectionMenuVisibilityTests(TestCase):
    """B1–B3 hardening + delete-signal safety for the section/menu axis."""

    def setUp(self):
        self.restaurant = Restaurant.objects.create(name='Spice Garden')
        self.location = Location.objects.create(restaurant=self.restaurant, name='Indiranagar')
        self.cat = MenuCategory.objects.create(
            location=self.location, name='Drinks', display_order=0
        )
        # Single-variant item (override is meaningful).
        self.soda = MenuItem.objects.create(category=self.cat, name='Lime Soda')
        Variant.objects.create(menu_item=self.soda, name='Regular', price=Decimal('30.00'))
        # Multi-variant item (override must be rejected — B3).
        self.pizza = MenuItem.objects.create(category=self.cat, name='Pizza')
        Variant.objects.create(menu_item=self.pizza, name='Small', price=Decimal('200.00'))
        Variant.objects.create(menu_item=self.pizza, name='Large', price=Decimal('400.00'))

        self.section = Section.objects.create(
            location=self.location, name='Bar', code='BAR', display_order=0
        )

    def _menu_with(self, name, item, price_override=None):
        menu = Menu.objects.create(location=self.location, name=name)
        MenuListing.objects.create(menu=menu, item=item, price_override=price_override)
        return menu

    # -- B1: empty menu cannot be assigned to a section --------------------
    def test_assigning_empty_menu_to_section_is_rejected_on_save(self):
        empty = Menu.objects.create(location=self.location, name='Empty Menu')
        with self.assertRaises(ValidationError):
            SectionMenu.objects.create(section=self.section, menu=empty)

    def test_assigning_non_empty_menu_succeeds(self):
        menu = self._menu_with('Bar Menu', self.soda, Decimal('50.00'))
        # Should not raise.
        SectionMenu.objects.create(section=self.section, menu=menu)
        self.assertTrue(
            SectionMenu.objects.filter(section=self.section, menu=menu).exists()
        )

    # -- B3: price_override only valid for single-variant items ------------
    def test_price_override_rejected_for_multi_variant_item(self):
        menu = Menu.objects.create(location=self.location, name='Bad Menu')
        with self.assertRaises(ValidationError):
            MenuListing.objects.create(menu=menu, item=self.pizza, price_override=Decimal('99'))

    def test_price_override_allowed_for_single_variant_item(self):
        menu = Menu.objects.create(location=self.location, name='OK Menu')
        listing = MenuListing.objects.create(
            menu=menu, item=self.soda, price_override=Decimal('50.00')
        )
        self.assertEqual(listing.price_override, Decimal('50.00'))

    def test_multi_variant_item_allowed_without_override(self):
        menu = Menu.objects.create(location=self.location, name='Pizza Menu')
        # No override → fine even for a multi-variant item.
        MenuListing.objects.create(menu=menu, item=self.pizza)
        self.assertTrue(MenuListing.objects.filter(menu=menu, item=self.pizza).exists())

    # -- B2: same item in two section menus → highest override wins --------
    def test_overlapping_overrides_are_deterministic_highest_wins(self):
        cheap = self._menu_with('Cheap', self.soda, Decimal('40.00'))
        pricey = self._menu_with('Pricey', self.soda, Decimal('55.00'))
        SectionMenu.objects.create(section=self.section, menu=cheap)
        SectionMenu.objects.create(section=self.section, menu=pricey)

        filtered, visible, overrides, _variant_overrides = MenuService._section_visibility(
            self.section
        )
        self.assertTrue(filtered)
        self.assertIn(str(self.soda.id), visible)
        self.assertEqual(overrides[str(self.soda.id)], Decimal('55.00'))

    # -- delete-signal safety: deleting must never raise in a receiver -----
    def test_deleting_menu_with_listings_and_section_link_bumps_and_no_error(self):
        menu = self._menu_with('Bar Menu', self.soda, Decimal('50.00'))
        SectionMenu.objects.create(section=self.section, menu=menu)
        v_before = MenuVersion.objects.get(location=self.location).version
        # Cascades MenuListing + SectionMenu deletes → their post_delete
        # receivers dereference instance.menu/.section. Must not raise.
        menu.delete()
        v_after = MenuVersion.objects.get(location=self.location).version
        self.assertGreater(v_after, v_before)

    def test_deleting_section_cascades_without_signal_error(self):
        menu = self._menu_with('Bar Menu', self.soda, Decimal('50.00'))
        SectionMenu.objects.create(section=self.section, menu=menu)
        v_before = MenuVersion.objects.get(location=self.location).version
        self.section.delete()  # cascades SectionMenu → post_delete reads .section
        v_after = MenuVersion.objects.get(location=self.location).version
        self.assertGreater(v_after, v_before)


class PerVariantSectionPricingTests(TestCase):
    """MenuListingVariantPrice: per-variant per-section pricing (multi-variant)."""

    def setUp(self):
        self.restaurant = Restaurant.objects.create(name='Spice Garden')
        self.location = Location.objects.create(restaurant=self.restaurant, name='Indiranagar')
        self.cat = MenuCategory.objects.create(
            location=self.location, name='Bar', display_order=0
        )
        # Multi-variant item: Whisky 30ml / 60ml.
        self.whisky = MenuItem.objects.create(category=self.cat, name='Whisky')
        self.v30 = Variant.objects.create(menu_item=self.whisky, name='30ml', price=Decimal('200.00'))
        self.v60 = Variant.objects.create(menu_item=self.whisky, name='60ml', price=Decimal('380.00'))
        # An unrelated item, to test the cross-item guard.
        self.soda = MenuItem.objects.create(category=self.cat, name='Soda')
        Variant.objects.create(menu_item=self.soda, name='Can', price=Decimal('30.00'))

        self.premium = Section.objects.create(
            location=self.location, name='Premium Bar', code='PREMIUM', display_order=0
        )
        self.menu = Menu.objects.create(location=self.location, name='Premium Bar Menu')
        self.listing = MenuListing.objects.create(menu=self.menu, item=self.whisky)
        SectionMenu.objects.create(section=self.premium, menu=self.menu)

    def _table_in_premium(self):
        return Table.objects.create(location=self.location, section=self.premium, label='P1')

    def test_variant_must_belong_to_listing_item(self):
        soda_variant = self.soda.variants.first()
        with self.assertRaises(ValidationError):
            MenuListingVariantPrice.objects.create(
                menu_listing=self.listing, variant=soda_variant, price=Decimal('99')
            )

    def test_per_variant_override_resolves_in_menu_for_table(self):
        MenuListingVariantPrice.objects.create(
            menu_listing=self.listing, variant=self.v30, price=Decimal('300.00')
        )
        MenuListingVariantPrice.objects.create(
            menu_listing=self.listing, variant=self.v60, price=Decimal('550.00')
        )
        table = self._table_in_premium()
        menu = MenuService.get_menu_for_table(str(table.id))
        item = next(
            i for c in menu['categories'] for i in c['items'] if i['id'] == str(self.whisky.id)
        )
        prices = {v['name']: v['price'] for v in item['variants']}
        self.assertEqual(prices['30ml'], '300.00')
        self.assertEqual(prices['60ml'], '550.00')
        # base ("from") price reflects cheapest effective variant.
        self.assertEqual(item['base_price'], '300.00')

    def test_snapshot_emits_variant_price_overrides(self):
        MenuListingVariantPrice.objects.create(
            menu_listing=self.listing, variant=self.v60, price=Decimal('550.00')
        )
        snap = MenuService.get_menu_snapshot(self.location, 0)
        premium = next(s for s in snap['sections'] if s['code'] == 'PREMIUM')
        self.assertTrue(premium['filtered'])
        self.assertEqual(premium['variant_price_overrides'][str(self.v60.id)], '550.00')
        # Catalogue itself stays at base prices; overrides live in the section block.
        whisky = next(
            i for c in snap['categories'] for i in c['items'] if i['id'] == str(self.whisky.id)
        )
        self.assertEqual(
            {v['name']: v['price'] for v in whisky['variants']},
            {'30ml': '200.00', '60ml': '380.00'},
        )

    def test_overlapping_variant_overrides_highest_wins(self):
        cheap = Menu.objects.create(location=self.location, name='Cheap')
        cl = MenuListing.objects.create(menu=cheap, item=self.whisky)
        MenuListingVariantPrice.objects.create(menu_listing=cl, variant=self.v60, price=Decimal('500.00'))
        MenuListingVariantPrice.objects.create(menu_listing=self.listing, variant=self.v60, price=Decimal('550.00'))
        SectionMenu.objects.create(section=self.premium, menu=cheap)

        _, _, _, variant_overrides = MenuService._section_visibility(self.premium)
        self.assertEqual(variant_overrides[str(self.v60.id)], Decimal('550.00'))
