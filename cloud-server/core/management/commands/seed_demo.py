"""Usage: python manage.py seed_demo

Seeds a multi-branch demo restaurant for local testing:
  - 2 locations with distinct menus (images on categories + items)
  - Staff users across owner / manager / waiter / staff / kiosk roles
  - Tables, printer stations, and API keys per branch
"""

from io import BytesIO

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand
from PIL import Image, ImageDraw, ImageFont

from core.authentication import ApiKeyAuth
from core.models import Location, PrintRoute, Restaurant, StaffUser
from menu.models import (
    Allergen,
    MenuCategory,
    MenuItem,
    MenuItemMedia,
    MenuSubCategory,
    MenuVersion,
    Modifier,
    ModifierGroup,
    MeatType,
    PreparationTime,
    PrinterStation,
    ServingInfo,
    Tag,
    TaxGroup,
    Unit,
    Variant,
)
from tables.models import Table

# ── Demo constants (update test scripts / UI placeholders if these change) ──
DEMO_PASSWORD = 'SobossDemo26!'
RESTAURANT_NAME = 'The Copper Pot'

BRANCHES = [
    {
        'name': 'Indiranagar',
        'address': '100 Feet Road, Indiranagar, Bangalore 560038',
        'tables': ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'],
        # Geofence centre (Indiranagar 100ft Rd) — staff clock in within 200 m.
        'latitude': 12.9719,
        'longitude': 77.6412,
        'geofence_radius_m': 200,
    },
    {
        'name': 'Koramangala',
        'address': '5th Block, Koramangala, Bangalore 560095',
        'tables': ['K1', 'K2', 'K3', 'K4', 'K5'],
        'latitude': 12.9352,
        'longitude': 77.6245,
        'geofence_radius_m': 200,
    },
]

STAFF_USERS = [
    # restaurant-wide owner (all locations on login)
    {
        'username': 'owner',
        'email': 'owner@copperpot.demo',
        'role': 'owner',
        'location_name': None,
        'first_name': 'Arjun',
        'last_name': 'Mehta',
    },
    # branch managers — use for main-node onboarding login
    {
        'username': 'manager.indira',
        'email': 'manager.indira@copperpot.demo',
        'role': 'manager',
        'location_name': 'Indiranagar',
        'first_name': 'Priya',
        'last_name': 'Sharma',
    },
    {
        'username': 'manager.kora',
        'email': 'manager.kora@copperpot.demo',
        'role': 'manager',
        'location_name': 'Koramangala',
        'first_name': 'Rahul',
        'last_name': 'Verma',
    },
    # waiters (mobile / POS ordering)
    {
        'username': 'waiter.indira',
        'email': 'waiter.indira@copperpot.demo',
        'role': 'waiter',
        'location_name': 'Indiranagar',
        'first_name': 'Suresh',
        'last_name': 'Kumar',
    },
    {
        'username': 'waiter.kora',
        'email': 'waiter.kora@copperpot.demo',
        'role': 'waiter',
        'location_name': 'Koramangala',
        'first_name': 'Anita',
        'last_name': 'Das',
    },
    # back-of-house staff
    {
        'username': 'kitchen.indira',
        'email': 'kitchen.indira@copperpot.demo',
        'role': 'staff',
        'location_name': 'Indiranagar',
        'first_name': 'Vijay',
        'last_name': 'Reddy',
    },
    {
        'username': 'bar.kora',
        'email': 'bar.kora@copperpot.demo',
        'role': 'staff',
        'location_name': 'Koramangala',
        'first_name': 'Neha',
        'last_name': 'Iyer',
    },
    # self-order kiosk (Indiranagar only)
    {
        'username': 'kiosk.indira',
        'email': 'kiosk.indira@copperpot.demo',
        'role': 'kiosk',
        'location_name': 'Indiranagar',
        'first_name': 'Kiosk',
        'last_name': 'Terminal',
    },
]


def _placeholder_image(label: str, color: tuple[int, int, int], size=(480, 320)) -> ContentFile:
    """Generate a labelled JPEG placeholder for menu testing."""
    img = Image.new('RGB', size, color)
    draw = ImageDraw.Draw(img)
    text = label[:28]
    try:
        font = ImageFont.truetype('arial.ttf', 28)
    except OSError:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size[0] - tw) // 2, (size[1] - th) // 2), text, fill=(255, 255, 255), font=font)
    buf = BytesIO()
    img.save(buf, format='JPEG', quality=88)
    slug = label.lower().replace(' ', '-').replace('/', '-')[:40]
    return ContentFile(buf.getvalue(), name=f'{slug}.jpg')


def _set_category_image(category: MenuCategory, label: str, color: tuple[int, int, int]) -> None:
    if category.image:
        return
    category.image.save(f'{category.id}.jpg', _placeholder_image(label, color), save=True)


def _attach_item_image(item: MenuItem, label: str, color: tuple[int, int, int]) -> None:
    if item.media.exists():
        return
    media = MenuItemMedia(menu_item=item, display_order=0, is_primary=True)
    media.image.save(f'{item.id}.jpg', _placeholder_image(label, color), save=True)


def _upsert_staff(
    *,
    restaurant: Restaurant,
    locations: dict[str, Location],
    username: str,
    email: str,
    role: str,
    location_name: str | None,
    first_name: str,
    last_name: str,
    password: str,
) -> StaffUser:
    location = locations.get(location_name) if location_name else None
    user, created = StaffUser.objects.get_or_create(
        username=username,
        defaults={
            'email': email,
            'role': role,
            'restaurant': restaurant,
            'location': location,
            'first_name': first_name,
            'last_name': last_name,
        },
    )
    changed = False
    for field, value in (
        ('email', email),
        ('role', role),
        ('restaurant', restaurant),
        ('location', location),
        ('first_name', first_name),
        ('last_name', last_name),
    ):
        if getattr(user, field) != value:
            setattr(user, field, value)
            changed = True
    if created or not user.check_password(password):
        user.set_password(password)
        changed = True
    if changed:
        user.save()
    return user


def _seed_stations(location: Location) -> tuple[PrinterStation, PrinterStation]:
    kitchen, _ = PrinterStation.objects.get_or_create(
        location=location, code='KITCHEN', defaults={'name': 'Kitchen'}
    )
    bar, _ = PrinterStation.objects.get_or_create(
        location=location, code='BAR', defaults={'name': 'Bar'}
    )
    return kitchen, bar


def _seed_print_routes(location: Location) -> None:
    for code in ['KITCHEN', 'BAR']:
        for ptype in ['KOT', 'BILL']:
            PrintRoute.objects.get_or_create(
                location=location,
                station_code=code,
                print_type=ptype,
                defaults={'assigned_node': None},
            )


def _seed_tables(location: Location, labels: list[str]) -> dict[str, Table]:
    tables: dict[str, Table] = {}
    for label in labels:
        table, created = Table.objects.get_or_create(location=location, label=label)
        tables[label] = table
        if created:
            pass  # logged by caller
    return tables


def _seed_indiranagar_menu(
    location: Location,
    kitchen: PrinterStation,
    bar: PrinterStation,
    *,
    veg: Tag,
    non_veg: Tag,
    spicy: Tag,
    chef_special: Tag,
    goods: Tag,
    gst5: TaxGroup,
    gst12: TaxGroup,
    prep_10_15: PreparationTime,
    serves_1_2: ServingInfo,
    chicken: MeatType,
    milk: Allergen,
    gluten: Allergen,
    grams: Unit,
) -> None:
    MenuVersion.objects.get_or_create(location=location)

    south, _ = MenuCategory.objects.get_or_create(
        location=location, name='South Indian', defaults={'display_order': 1}
    )
    _set_category_image(south, 'South Indian', (210, 140, 60))

    dosas, _ = MenuSubCategory.objects.get_or_create(
        category=south, name='Dosas & Uttapam', defaults={'display_order': 1}
    )
    rice, _ = MenuSubCategory.objects.get_or_create(
        category=south, name='Rice & Biryani', defaults={'display_order': 2}
    )

    beverages, _ = MenuCategory.objects.get_or_create(
        location=location, name='Beverages', defaults={'display_order': 2}
    )
    _set_category_image(beverages, 'Beverages', (90, 55, 30))

    masala_dosa, _ = MenuItem.objects.get_or_create(
        category=south,
        name='Masala Dosa',
        defaults={
            'description': 'Crisp rice crepe with spiced potato filling',
            'subcategory': dosas,
            'station': kitchen,
            'preparation_time': prep_10_15,
            'serving_info': serves_1_2,
            'calorie_count': 320,
        },
    )
    masala_dosa.tags.set([veg, goods, chef_special])
    masala_dosa.allergens.set([gluten])
    Variant.objects.get_or_create(
        menu_item=masala_dosa, name='Regular',
        defaults={'price': '149.00', 'tax_group': gst5},
    )
    grp, _ = ModifierGroup.objects.get_or_create(
        menu_item=masala_dosa,
        name='Chutney Choice',
        defaults={'min_selection': 0, 'max_selection': 2},
    )
    Modifier.objects.get_or_create(group=grp, name='Extra Sambar', defaults={'price': '20'})
    Modifier.objects.get_or_create(group=grp, name='Gunpowder', defaults={'price': '25'})
    _attach_item_image(masala_dosa, 'Masala Dosa', (235, 180, 80))

    chicken_biryani, _ = MenuItem.objects.get_or_create(
        category=south,
        name='Chicken Dum Biryani',
        defaults={
            'description': 'Slow-cooked basmati rice with marinated chicken',
            'subcategory': rice,
            'station': kitchen,
            'preparation_time': prep_10_15,
            'serving_info': serves_1_2,
        },
    )
    chicken_biryani.tags.set([non_veg, goods, spicy, chef_special])
    chicken_biryani.meat_types.set([chicken])
    chicken_biryani.allergens.set([milk])
    Variant.objects.get_or_create(
        menu_item=chicken_biryani, name='Half',
        defaults={'price': '279.00', 'tax_group': gst5, 'portion_value': '500', 'portion_unit': grams},
    )
    Variant.objects.get_or_create(
        menu_item=chicken_biryani, name='Full',
        defaults={'price': '449.00', 'tax_group': gst5, 'portion_value': '900', 'portion_unit': grams},
    )
    _attach_item_image(chicken_biryani, 'Chicken Biryani', (165, 95, 45))

    filter_coffee, _ = MenuItem.objects.get_or_create(
        category=beverages,
        name='Filter Coffee',
        defaults={
            'description': 'South Indian decoction with frothy milk',
            'station': bar,
        },
    )
    filter_coffee.tags.set([veg, goods])
    Variant.objects.get_or_create(
        menu_item=filter_coffee, name='Regular',
        defaults={'price': '59.00', 'tax_group': gst5},
    )
    Variant.objects.get_or_create(
        menu_item=filter_coffee, name='Large',
        defaults={'price': '79.00', 'tax_group': gst5},
    )
    _attach_item_image(filter_coffee, 'Filter Coffee', (110, 70, 40))


def _seed_koramangala_menu(
    location: Location,
    kitchen: PrinterStation,
    bar: PrinterStation,
    *,
    veg: Tag,
    non_veg: Tag,
    spicy: Tag,
    goods: Tag,
    gst5: TaxGroup,
    gst12: TaxGroup,
    prep_10_15: PreparationTime,
    serves_2_3: ServingInfo,
    chicken: MeatType,
    gluten: Allergen,
    milk: Allergen,
) -> None:
    MenuVersion.objects.get_or_create(location=location)

    mains, _ = MenuCategory.objects.get_or_create(
        location=location, name='Continental Mains', defaults={'display_order': 1}
    )
    _set_category_image(mains, 'Continental', (180, 100, 70))

    drinks, _ = MenuCategory.objects.get_or_create(
        location=location, name='Bar & Drinks', defaults={'display_order': 2}
    )
    _set_category_image(drinks, 'Bar & Drinks', (70, 130, 180))

    burger, _ = MenuItem.objects.get_or_create(
        category=mains,
        name='Smoky Chicken Burger',
        defaults={
            'description': 'Grilled patty, cheddar, caramelised onion, house sauce',
            'station': kitchen,
            'preparation_time': prep_10_15,
            'serving_info': serves_2_3,
            'calorie_count': 540,
        },
    )
    burger.tags.set([non_veg, goods, spicy])
    burger.meat_types.set([chicken])
    burger.allergens.set([gluten, milk])
    Variant.objects.get_or_create(
        menu_item=burger, name='Single',
        defaults={'price': '329.00', 'tax_group': gst12},
    )
    Variant.objects.get_or_create(
        menu_item=burger, name='Meal Combo',
        defaults={'price': '429.00', 'tax_group': gst12},
    )
    grp, _ = ModifierGroup.objects.get_or_create(
        menu_item=burger,
        name='Add-ons',
        defaults={'min_selection': 0, 'max_selection': 3},
    )
    Modifier.objects.get_or_create(group=grp, name='Extra Cheese', defaults={'price': '45'})
    Modifier.objects.get_or_create(group=grp, name='Bacon Strip', defaults={'price': '65'})
    _attach_item_image(burger, 'Chicken Burger', (200, 110, 55))

    pasta, _ = MenuItem.objects.get_or_create(
        category=mains,
        name='Creamy Alfredo Pasta',
        defaults={
            'description': 'Penne in parmesan cream sauce with herbs',
            'station': kitchen,
            'preparation_time': prep_10_15,
        },
    )
    pasta.tags.set([veg, goods])
    pasta.allergens.set([gluten, milk])
    Variant.objects.get_or_create(
        menu_item=pasta, name='Regular',
        defaults={'price': '299.00', 'tax_group': gst12},
    )
    _attach_item_image(pasta, 'Alfredo Pasta', (245, 220, 170))

    mojito, _ = MenuItem.objects.get_or_create(
        category=drinks,
        name='Virgin Mojito',
        defaults={
            'description': 'Mint, lime, soda — no alcohol',
            'station': bar,
        },
    )
    mojito.tags.set([veg, goods])
    Variant.objects.get_or_create(
        menu_item=mojito, name='Regular',
        defaults={'price': '189.00', 'tax_group': gst12},
    )
    _attach_item_image(mojito, 'Virgin Mojito', (90, 190, 150))


class Command(BaseCommand):
    help = 'Seed multi-branch demo restaurant with menus, images, and staff users'

    def handle(self, *args, **options):
        restaurant, _ = Restaurant.objects.get_or_create(
            name=RESTAURANT_NAME,
            defaults={
                'phone': '9988776655',
                'address': 'Bangalore, Karnataka',
                'contact_email': 'hello@copperpot.demo',
                'legal_name': 'Copper Pot Foods Pvt Ltd',
            },
        )
        self.stdout.write(f'Restaurant: {restaurant.name} ({restaurant.id})')

        # Glossary tags/tax groups are seeded by the menu data migration.
        veg = Tag.objects.get(slug='veg')
        non_veg = Tag.objects.get(slug='non-veg')
        spicy = Tag.objects.get(slug='spicy')
        chef_special = Tag.objects.get(slug='chef-special')
        goods = Tag.objects.get(slug='goods')
        gst5 = TaxGroup.objects.get(slug='GST_D_P_5.00')
        gst12 = TaxGroup.objects.get(slug='GST_D_P_12.00')
        prep_10_15 = PreparationTime.objects.get(slug='10to15min')
        serves_1_2 = ServingInfo.objects.get(slug='1to2people')
        serves_2_3 = ServingInfo.objects.get(slug='2to3people')
        chicken = MeatType.objects.get(slug='chicken')
        milk = Allergen.objects.get(slug='milk')
        gluten = Allergen.objects.get(slug='gluten')
        grams = Unit.objects.get(slug='grams')

        locations: dict[str, Location] = {}
        api_keys: dict[str, str] = {}
        branch_tables: dict[str, dict[str, Table]] = {}

        for branch in BRANCHES:
            location, _ = Location.objects.get_or_create(
                restaurant=restaurant,
                name=branch['name'],
                defaults={
                    'address': branch['address'],
                    'latitude': branch.get('latitude'),
                    'longitude': branch.get('longitude'),
                    'geofence_radius_m': branch.get('geofence_radius_m', 200),
                },
            )
            locations[branch['name']] = location
            self.stdout.write(f'  Branch: {location.name} ({location.id})')

            kitchen, bar = _seed_stations(location)
            _seed_print_routes(location)
            branch_tables[branch['name']] = _seed_tables(location, branch['tables'])
            api_keys[branch['name']] = ApiKeyAuth.issue_key(location)

            if branch['name'] == 'Indiranagar':
                _seed_indiranagar_menu(
                    location, kitchen, bar,
                    veg=veg, non_veg=non_veg, spicy=spicy, chef_special=chef_special,
                    goods=goods, gst5=gst5, gst12=gst12,
                    prep_10_15=prep_10_15, serves_1_2=serves_1_2,
                    chicken=chicken, milk=milk, gluten=gluten, grams=grams,
                )
            else:
                _seed_koramangala_menu(
                    location, kitchen, bar,
                    veg=veg, non_veg=non_veg, spicy=spicy, goods=goods,
                    gst5=gst5, gst12=gst12, prep_10_15=prep_10_15,
                    serves_2_3=serves_2_3, chicken=chicken,
                    gluten=gluten, milk=milk,
                )

        self.stdout.write('\nStaff users:')
        for spec in STAFF_USERS:
            user = _upsert_staff(
                restaurant=restaurant,
                locations=locations,
                password=DEMO_PASSWORD,
                **spec,
            )
            loc_label = spec['location_name'] or 'all branches'
            self.stdout.write(f'  {user.role:8} {user.email:35} @ {loc_label}')

        indira = locations['Indiranagar']
        kora = locations['Koramangala']
        t1 = branch_tables['Indiranagar']['T1']
        k1 = branch_tables['Koramangala']['K1']

        self.stdout.write(self.style.SUCCESS('\n--- DEMO CREDENTIALS ---'))
        self.stdout.write(f'Restaurant  : {RESTAURANT_NAME}')
        self.stdout.write(f'Password    : {DEMO_PASSWORD}  (all demo users)')
        self.stdout.write('')
        self.stdout.write('Branches:')
        self.stdout.write(f'  Indiranagar  ID={indira.id}')
        self.stdout.write(f'    API Key    : {api_keys["Indiranagar"]}')
        self.stdout.write(f'    Table T1   : {t1.id}')
        self.stdout.write(f'  Koramangala  ID={kora.id}')
        self.stdout.write(f'    API Key    : {api_keys["Koramangala"]}')
        self.stdout.write(f'    Table K1   : {k1.id}')
        self.stdout.write('')
        self.stdout.write('Users (email / password):')
        self.stdout.write(f'  Owner (all branches)     : owner@copperpot.demo')
        self.stdout.write(f'  Manager - Indiranagar    : manager.indira@copperpot.demo  (main-node login)')
        self.stdout.write(f'  Manager - Koramangala    : manager.kora@copperpot.demo')
        self.stdout.write(f'  Waiter  - Indiranagar    : waiter.indira@copperpot.demo')
        self.stdout.write(f'  Waiter  - Koramangala    : waiter.kora@copperpot.demo')
        self.stdout.write(f'  Kitchen - Indiranagar    : kitchen.indira@copperpot.demo')
        self.stdout.write(f'  Bar staff - Koramangala  : bar.kora@copperpot.demo')
        self.stdout.write(f'  Kiosk - Indiranagar      : kiosk.indira@copperpot.demo')
        self.stdout.write(self.style.SUCCESS('\nSeed complete!'))
