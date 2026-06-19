"""Usage: python manage.py seed_demo"""

from django.core.management.base import BaseCommand

from core.authentication import ApiKeyAuth
from core.models import Location, PrintRoute, Restaurant
from menu.models import (
    Kitchen,
    Menu,
    MenuCategory,
    MenuItem,
    MenuListing,
    MenuVersion,
    Modifier,
    ModifierGroup,
    PrinterStation,
    Tag,
    TaxGroup,
    Variant,
)
from tables.models import Section, Table


class Command(BaseCommand):
    help = 'Seed demo data'

    def handle(self, *args, **options):
        restaurant, _ = Restaurant.objects.get_or_create(
            name='Spice Garden',
            defaults={'phone': '9876543210', 'address': 'MG Road, Bangalore'},
        )
        location, _ = Location.objects.get_or_create(
            restaurant=restaurant,
            name='MG Road',
            defaults={'address': 'MG Road, Bangalore'},
        )
        self.stdout.write(f'Location: {location.id}')

        # ── Kitchens (KOT routing axis) ─────────────────────────────────────
        kitchen, _ = Kitchen.objects.get_or_create(
            location=location, code='KITCHEN', defaults={'name': 'Main Kitchen'}
        )
        bar_kitchen, _ = Kitchen.objects.get_or_create(
            location=location, code='BAR', defaults={'name': 'Bar'}
        )

        # Keep legacy PrinterStation rows so existing foreign keys don't break.
        ps_kitchen, _ = PrinterStation.objects.get_or_create(
            location=location, code='KITCHEN', defaults={'name': 'Kitchen'}
        )
        PrinterStation.objects.get_or_create(
            location=location, code='BAR', defaults={'name': 'Bar'}
        )

        # ── Sections (BILL routing + visibility axis) ────────────────────────
        main_floor, _ = Section.objects.get_or_create(
            location=location,
            code='DEFAULT',
            defaults={'name': 'Main Floor', 'display_order': 0},
        )
        bar_section, _ = Section.objects.get_or_create(
            location=location,
            code='BAR',
            defaults={'name': 'Bar Area', 'display_order': 1},
        )

        # ── Glossary tags / tax groups (seeded by menu data migration) ───────
        veg = Tag.objects.get(slug='veg')
        goods = Tag.objects.get(slug='goods')
        spicy = Tag.objects.get(slug='spicy')
        gst5 = TaxGroup.objects.get(slug='GST_D_P_5.00')

        MenuVersion.objects.get_or_create(location=location)

        # ── Menu categories ───────────────────────────────────────────────────
        mains, _ = MenuCategory.objects.get_or_create(
            location=location,
            name='Mains',
            defaults={'display_order': 1, 'kitchen': kitchen},
        )
        drinks, _ = MenuCategory.objects.get_or_create(
            location=location,
            name='Drinks',
            defaults={'display_order': 2, 'kitchen': bar_kitchen},
        )

        # ── Menu items ────────────────────────────────────────────────────────
        pizza, _ = MenuItem.objects.get_or_create(
            category=mains,
            name='Margherita Pizza',
            defaults={
                'description': 'Classic tomato + mozzarella',
                'station': ps_kitchen,
                'kitchen': kitchen,
            },
        )
        pizza.tags.add(veg, goods)
        Variant.objects.get_or_create(
            menu_item=pizza, name='S', defaults={'price': '299.00', 'tax_group': gst5}
        )
        Variant.objects.get_or_create(
            menu_item=pizza, name='L', defaults={'price': '419.00', 'tax_group': gst5}
        )
        grp, _ = ModifierGroup.objects.get_or_create(
            menu_item=pizza,
            name='Add-ons',
            defaults={'min_selection': 0, 'max_selection': 3},
        )
        Modifier.objects.get_or_create(
            group=grp, name='Extra Cheese', defaults={'price': '40'}
        )

        ps_bar = PrinterStation.objects.get(location=location, code='BAR')
        soda, _ = MenuItem.objects.get_or_create(
            category=drinks,
            name='Lime Soda',
            defaults={'station': ps_bar, 'kitchen': bar_kitchen},
        )
        soda.tags.add(veg, goods, spicy)
        Variant.objects.get_or_create(
            menu_item=soda, name='Regular', defaults={'price': '79.00', 'tax_group': gst5}
        )

        # ── Tables — assign to sections ───────────────────────────────────────
        for label in ['T1', 'T2', 'T3', 'T4']:
            t, created = Table.objects.get_or_create(
                location=location, label=label, defaults={'section': main_floor}
            )
            if not created and t.section is None:
                t.section = main_floor
                t.save(update_fields=['section'])
            if created:
                self.stdout.write(f'Table {label}: {t.id}')

        for label in ['B1', 'B2']:
            t, created = Table.objects.get_or_create(
                location=location, label=label, defaults={'section': bar_section}
            )
            if not created and t.section is None:
                t.section = bar_section
                t.save(update_fields=['section'])
            if created:
                self.stdout.write(f'Table {label}: {t.id}')

        # ── Menus (visibility axis) ───────────────────────────────────────────
        main_menu, _ = Menu.objects.get_or_create(
            location=location,
            name='Full Menu',
            defaults={'is_active': True},
        )
        bar_menu, _ = Menu.objects.get_or_create(
            location=location,
            name='Bar Menu',
            defaults={'is_active': True},
        )

        # Section → Menu assignments
        from menu.models import SectionMenu
        SectionMenu.objects.get_or_create(section=main_floor, menu=main_menu)
        SectionMenu.objects.get_or_create(section=bar_section, menu=bar_menu)

        # Items in menus (MenuListing)
        MenuListing.objects.get_or_create(menu=main_menu, item=pizza)
        MenuListing.objects.get_or_create(menu=main_menu, item=soda)
        MenuListing.objects.get_or_create(menu=bar_menu, item=soda,
                                          defaults={'price_override': '50.00'})

        # ── PrintRoute rows ───────────────────────────────────────────────────
        # Unassigned routes print on the leader locally. Assign a follower node
        # in Node Management when you add dedicated kitchen/bar printer nodes.
        routes_to_seed = [
            ('KITCHEN', 'KOT'),
            ('KITCHEN', 'BILL'),
            ('BAR', 'KOT'),
            ('DEFAULT', 'BILL'),
            ('BAR', 'BILL'),
        ]
        for code, ptype in routes_to_seed:
            PrintRoute.objects.get_or_create(
                location=location,
                station_code=code,
                print_type=ptype,
                defaults={'assigned_node': None},
            )

        # ── Manager user ──────────────────────────────────────────────────────
        from core.models import StaffUser
        manager_email = 'manager@biryani.com'
        manager_username = 'manager'
        manager_password = 'password123'

        manager, created = StaffUser.objects.get_or_create(
            username=manager_username,
            defaults={
                'email': manager_email,
                'role': 'manager',
                'restaurant': restaurant,
            }
        )
        if created or not manager.check_password(manager_password):
            manager.set_password(manager_password)
            manager.save()
            self.stdout.write('Manager user created/updated.')

        raw_key = ApiKeyAuth.issue_key(location)

        t1 = Table.objects.filter(location=location, label='T1').first()
        self.stdout.write(self.style.SUCCESS('\n--- DEMO CREDENTIALS ---'))
        self.stdout.write(f'Location ID : {location.id}')
        self.stdout.write(f'API Key     : {raw_key}')
        self.stdout.write(f'Table T1 ID : {t1.id if t1 else "N/A"}')
        self.stdout.write(f'Manager     : {manager_email} / {manager_password}')
        self.stdout.write(self.style.SUCCESS('Seed complete!'))
