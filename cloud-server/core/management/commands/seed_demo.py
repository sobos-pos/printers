"""Usage: python manage.py seed_demo"""

from django.core.management.base import BaseCommand

from core.authentication import ApiKeyAuth
from core.models import Location, Restaurant
from menu.models import (
    DietaryTag,
    MenuCategory,
    MenuItem,
    MenuVersion,
    Modifier,
    ModifierGroup,
    PrinterStation,
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

        veg, _ = DietaryTag.objects.get_or_create(label='Veg', defaults={'icon': 'leaf'})
        DietaryTag.objects.get_or_create(label='Spicy', defaults={'icon': 'fire'})

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
                'base_price': '299.00',
                'station': kitchen,
            },
        )
        pizza.dietary_tags.add(veg)
        Variant.objects.get_or_create(menu_item=pizza, name='S', defaults={'price_delta': '0'})
        Variant.objects.get_or_create(menu_item=pizza, name='L', defaults={'price_delta': '120'})
        grp, _ = ModifierGroup.objects.get_or_create(
            menu_item=pizza,
            name='Add-ons',
            defaults={'min_select': 0, 'max_select': 3},
        )
        Modifier.objects.get_or_create(
            group=grp, name='Extra Cheese', defaults={'price_delta': '40'}
        )

        bar = PrinterStation.objects.get(location=location, code='BAR')
        MenuItem.objects.get_or_create(
            category=drinks,
            name='Lime Soda',
            defaults={'base_price': '79.00', 'station': bar},
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
        t1 = Table.objects.filter(location=location, label='T1').first()
        self.stdout.write(self.style.SUCCESS('\n--- DEMO CREDENTIALS ---'))
        self.stdout.write(f'Location ID : {location.id}')
        self.stdout.write(f'API Key     : {raw_key}')
        self.stdout.write(f'Table T1 ID : {t1.id}')
        self.stdout.write(f'Manager     : {manager_email} / {manager_password}')
        self.stdout.write(self.style.SUCCESS('Seed complete!'))
