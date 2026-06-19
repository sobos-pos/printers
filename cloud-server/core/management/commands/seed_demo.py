"""Usage: python manage.py seed_demo"""

from django.core.management.base import BaseCommand

from core.authentication import ApiKeyAuth
from core.models import Location, Restaurant
from menu.models import (
    MenuCategory,
    MenuItem,
    MenuVersion,
    Modifier,
    ModifierGroup,
    PrinterStation,
    Tag,
    TaxGroup,
    Variant,
)
from tables.models import Table


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

        kitchen, _ = PrinterStation.objects.get_or_create(
            location=location, code='KITCHEN', defaults={'name': 'Kitchen'}
        )
        PrinterStation.objects.get_or_create(
            location=location, code='BAR', defaults={'name': 'Bar'}
        )

        # Glossary tags/tax groups are seeded by the menu data migration.
        veg = Tag.objects.get(slug='veg')
        goods = Tag.objects.get(slug='goods')
        spicy = Tag.objects.get(slug='spicy')
        gst5 = TaxGroup.objects.get(slug='GST_D_P_5.00')

        MenuVersion.objects.get_or_create(location=location)

        mains, _ = MenuCategory.objects.get_or_create(
            location=location, name='Mains', defaults={'display_order': 1}
        )
        drinks, _ = MenuCategory.objects.get_or_create(
            location=location, name='Drinks', defaults={'display_order': 2}
        )

        pizza, _ = MenuItem.objects.get_or_create(
            category=mains,
            name='Margherita Pizza',
            defaults={
                'description': 'Classic tomato + mozzarella',
                'station': kitchen,
            },
        )
        pizza.tags.add(veg, goods)
        # Variants carry the absolute price + tax group (no item base price).
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

        bar = PrinterStation.objects.get(location=location, code='BAR')
        soda, _ = MenuItem.objects.get_or_create(
            category=drinks,
            name='Lime Soda',
            defaults={'station': bar},
        )
        soda.tags.add(veg, goods, spicy)
        Variant.objects.get_or_create(
            menu_item=soda, name='Regular', defaults={'price': '79.00', 'tax_group': gst5}
        )

        for label in ['T1', 'T2', 'T3', 'T4', 'T5']:
            t, created = Table.objects.get_or_create(location=location, label=label)
            if created:
                self.stdout.write(f'Table {label}: {t.id}')

        # Create a manager user
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
            self.stdout.write(f'Manager user created/updated.')

        raw_key = ApiKeyAuth.issue_key(location)

        from core.models import PrintRoute

        # Unassigned routes print on the leader locally. Assign a follower node in
        # Node Management when you add dedicated kitchen/bar printer nodes.
        for code in ['KITCHEN', 'BAR']:
            for ptype in ['KOT', 'BILL']:
                PrintRoute.objects.get_or_create(
                    location=location,
                    station_code=code,
                    print_type=ptype,
                    defaults={'assigned_node': None},
                )

        t1 = Table.objects.filter(location=location, label='T1').first()
        self.stdout.write(self.style.SUCCESS('\n--- DEMO CREDENTIALS ---'))
        self.stdout.write(f'Location ID : {location.id}')
        self.stdout.write(f'API Key     : {raw_key}')
        self.stdout.write(f'Table T1 ID : {t1.id}')
        self.stdout.write(f'Manager     : {manager_email} / {manager_password}')
        self.stdout.write(self.style.SUCCESS('Seed complete!'))
