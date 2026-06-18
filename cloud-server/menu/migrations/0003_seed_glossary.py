"""Seed the menu glossary / reference lookup tables.

Values are taken verbatim from menu_management.md (the Zomato POS
integration menu glossary). The migration is idempotent — it uses
update_or_create keyed on slug — so it is safe to re-run and to amend.
"""

from decimal import Decimal

from django.db import migrations


TAX_GROUPS = [
    # slug, name, rate
    ('GST_D_P_5.00', 'GST', '5'),
    ('GST_D_P_12.00', 'GST', '12'),
    ('GST_D_P_18.00', 'GST', '18'),
    ('KERALACESS_D_P_1.00', 'Kerala Cess', '1'),
    ('MUNICIPALITYTAX_D_P_10.00', 'Municipality Tax', '10'),
    ('MUNICIPALITYTAX_D_P_2.00', 'Municipality Tax', '2'),
    ('MUNICIPALITYTAX_D_P_7.00', 'Municipality Tax', '7'),
    ('MUNICIPALITYTAX_D_P_3.50', 'Municipality Tax', '3.5'),
    ('VAT_D_P_5.00', 'VAT', '5'),
]

TAXES = [
    # slug, name, display_name, rate
    ('CGST_D_P_2.50', 'CGST', 'CGST@2.5', '2.5'),
    ('CGST_D_P_6.00', 'CGST', 'CGST@6', '6'),
    ('CGST_D_P_9.00', 'CGST', 'CGST@9', '9'),
    ('SGST_D_P_2.50', 'SGST', 'SGST@2.5', '2.5'),
    ('SGST_D_P_6.00', 'SGST', 'SGST@6', '6'),
    ('SGST_D_P_9.00', 'SGST', 'SGST@9', '9'),
    ('KERALACESS_D_P_1.00', 'Kerala Cess', 'Kerala Cess', '1'),
    ('MUNICIPALITYTAX_D_P_10.00', 'Municipality Tax', 'Municipality Tax@10', '10'),
    ('MUNICIPALITYTAX_D_P_2.00', 'Municipality Tax', 'Municipality Tax@2', '2'),
    ('MUNICIPALITYTAX_D_P_7.00', 'Municipality Tax', 'Municipality Tax@7', '7'),
    ('MUNICIPALITYTAX_D_P_3.50', 'Municipality Tax', 'Municipality Tax@3.5', '3.5'),
    ('VAT_D_P_5.00', 'VAT', 'VAT@5', '5'),
]

# tax_group_slug -> [tax_slug, ...]
TAX_GROUP_MAP = {
    'GST_D_P_5.00': ['CGST_D_P_2.50', 'SGST_D_P_2.50'],
    'GST_D_P_12.00': ['CGST_D_P_6.00', 'SGST_D_P_6.00'],
    'GST_D_P_18.00': ['CGST_D_P_9.00', 'SGST_D_P_9.00'],
    'KERALACESS_D_P_1.00': ['KERALACESS_D_P_1.00'],
    'MUNICIPALITYTAX_D_P_10.00': ['MUNICIPALITYTAX_D_P_10.00'],
    'MUNICIPALITYTAX_D_P_2.00': ['MUNICIPALITYTAX_D_P_2.00'],
    'MUNICIPALITYTAX_D_P_7.00': ['MUNICIPALITYTAX_D_P_7.00'],
    'MUNICIPALITYTAX_D_P_3.50': ['MUNICIPALITYTAX_D_P_3.50'],
    'VAT_D_P_5.00': ['VAT_D_P_5.00'],
}

CHARGES = [
    # slug, name, display_name, calc_type
    ('PC_D_F', 'Packaging Charge - Fixed', 'Packaging Charge', 'fixed'),
    ('PC_D_P', 'Packaging Charge - Percentage', 'Packaging Charge', 'percentage'),
]

UNITS = [
    ('grams', 'Grams'), ('kg', 'Kilograms'), ('ml', 'Millilitres'),
    ('litre', 'Litres'), ('ounces', 'Ounces'), ('pounds', 'Pounds'),
    ('serves', 'Serves'), ('piece', 'Piece'), ('slice', 'Slice'),
    ('scoop', 'Scoop'), ('inches', 'Inches'), ('cms', 'Centimetres'),
]

PREP_TIMES = [
    # slug, label, min, max
    ('0to5min', '0–5 minutes', 0, 5),
    ('5to10min', '5–10 minutes', 5, 10),
    ('10to15min', '10–15 minutes', 10, 15),
    ('15to20min', '15–20 minutes', 15, 20),
    ('20to25min', '20–25 minutes', 20, 25),
    ('25to30min', '25–30 minutes', 25, 30),
    ('30to35min', '30–35 minutes', 30, 35),
    ('35to40min', '35–40 minutes', 35, 40),
    ('40to45min', '40–45 minutes', 40, 45),
    ('45to50min', '45–50 minutes', 45, 50),
    ('50to55min', '50–55 minutes', 50, 55),
    ('55to60min', '55–60 minutes', 55, 60),
    ('60+min', 'More than 60 minutes', 60, None),
]

SERVING_INFO = [
    ('1to2people', 'Serves 1–2 people'),
    ('2to3people', 'Serves 2–3 people'),
    ('3to4people', 'Serves 3–4 people'),
    ('4to5people', 'Serves 4–5 people'),
    ('5to6people', 'Serves 5–6 people'),
    ('6to7people', 'Serves 6–7 people'),
    ('7to8people', 'Serves 7–8 people'),
    ('8to9people', 'Serves 8–9 people'),
    ('9to10people', 'Serves 9–10 people'),
    ('10+people', 'Serves 10+ people'),
]

MEAT_TYPES = [
    'chicken', 'mutton', 'goat', 'lamb', 'fish', 'prawn', 'shrimp', 'crab',
    'lobster', 'squid', 'octopus', 'shellfish', 'duck', 'turkey', 'quail',
    'pigeon', 'goose', 'rabbit', 'pork', 'veal', 'venison', 'deer', 'bull',
    'camel', 'frog', 'shark',
]

ALLERGENS = [
    ('gluten', 'Gluten (wheat, barley, rye)'),
    ('crustacean', 'Crustacean (crab, lobster, shrimp)'),
    ('egg', 'Egg'),
    ('fish', 'Fish'),
    ('tree-nuts', 'Tree Nuts'),
    ('peanut', 'Peanut'),
    ('soybeans', 'Soybeans'),
    ('milk', 'Milk (dairy, lactose)'),
    ('sulphite', 'Sulphite'),
]

# slug, name, tag_type, selection
TAGS = [
    # Dietary (mandatory, single)
    ('veg', 'Veg', 'dietary', 'single'),
    ('non-veg', 'Non-Veg', 'dietary', 'single'),
    ('egg', 'Egg', 'dietary', 'single'),
    # Miscellaneous (multi)
    ('cake', 'Cake', 'misc', 'multi'),
    ('chef-special', "Chef's Special", 'misc', 'multi'),
    ('dairy-free', 'Dairy Free', 'misc', 'multi'),
    ('fodmap-friendly', 'FODMAP Friendly', 'misc', 'multi'),
    ('gluten-free', 'Gluten Free', 'misc', 'multi'),
    ('lactose-free', 'Lactose Free', 'misc', 'multi'),
    ('new', 'New', 'misc', 'multi'),
    ('restaurant-recommended', 'Restaurant Recommended', 'misc', 'multi'),
    ('seasonal', 'Seasonal', 'misc', 'multi'),
    ('spicy', 'Spicy', 'misc', 'multi'),
    ('vegan', 'Vegan', 'misc', 'multi'),
    ('wheat-free', 'Wheat Free', 'misc', 'multi'),
    ('contains-pork', 'Contains Pork', 'misc', 'multi'),
    ('home-style-meal', 'Home Style Meal', 'misc', 'multi'),
    # Legally sensitive (multi)
    ('contains-alcohol', 'Contains Alcohol', 'legal', 'multi'),
    # Info (multi)
    ('mrp-item', 'MRP Item', 'info', 'multi'),
    # GST classification (single)
    ('goods', 'Goods', 'gst', 'single'),
    ('services', 'Services', 'gst', 'single'),
    # Celebration-cake flavors (single)
    ('cake-flavor-chocolate', 'Chocolate', 'cake_flavor', 'single'),
    ('cake-flavor-black-forest', 'Black Forest', 'cake_flavor', 'single'),
    ('cake-flavor-vanilla', 'Vanilla', 'cake_flavor', 'single'),
    ('cake-flavor-fruit', 'Fruit', 'cake_flavor', 'single'),
    ('cake-flavor-pineapple', 'Pineapple', 'cake_flavor', 'single'),
    ('cake-flavor-butterscotch', 'Butterscotch', 'cake_flavor', 'single'),
    ('cake-flavor-red-velvet', 'Red Velvet', 'cake_flavor', 'single'),
    ('cake-flavor-blueberry', 'Blueberry', 'cake_flavor', 'single'),
    ('cake-flavor-cheesecake', 'Cheese Cake', 'cake_flavor', 'single'),
    ('cake-flavor-strawberry', 'Strawberry', 'cake_flavor', 'single'),
    ('cake-flavor-cream', 'Cream', 'cake_flavor', 'single'),
    ('cake-flavor-mango', 'Mango', 'cake_flavor', 'single'),
    # Cake type (multi)
    ('anniversary-wedding-cake', 'Anniversary/Wedding Cake', 'cake_type', 'multi'),
    ('tiered-cake', 'Tiered Cake', 'cake_type', 'multi'),
    ('birthday-cake', 'Birthday Cake', 'cake_type', 'multi'),
    ('kids-birthday-cake', 'Kids Birthday Cake', 'cake_type', 'multi'),
    ('gourmet-cake', 'Gourmet Cake', 'cake_type', 'multi'),
    ('premium-cake', 'Premium Cake', 'cake_type', 'multi'),
]


def seed(apps, schema_editor):
    TaxGroup = apps.get_model('menu', 'TaxGroup')
    Tax = apps.get_model('menu', 'Tax')
    TaxGroupTax = apps.get_model('menu', 'TaxGroupTax')
    Charge = apps.get_model('menu', 'Charge')
    Unit = apps.get_model('menu', 'Unit')
    PreparationTime = apps.get_model('menu', 'PreparationTime')
    ServingInfo = apps.get_model('menu', 'ServingInfo')
    MeatType = apps.get_model('menu', 'MeatType')
    Allergen = apps.get_model('menu', 'Allergen')
    Tag = apps.get_model('menu', 'Tag')

    for slug, name, rate in TAX_GROUPS:
        TaxGroup.objects.update_or_create(
            slug=slug,
            defaults={'name': name, 'calc_type': 'percentage', 'rate': Decimal(rate), 'service': 'all'},
        )
    for slug, name, display, rate in TAXES:
        Tax.objects.update_or_create(
            slug=slug,
            defaults={'name': name, 'display_name': display, 'calc_type': 'percentage', 'rate': Decimal(rate), 'service': 'all'},
        )
    for group_slug, tax_slugs in TAX_GROUP_MAP.items():
        group = TaxGroup.objects.get(slug=group_slug)
        for tax_slug in tax_slugs:
            tax = Tax.objects.get(slug=tax_slug)
            TaxGroupTax.objects.update_or_create(tax_group=group, tax=tax)

    for slug, name, display, calc in CHARGES:
        Charge.objects.update_or_create(
            slug=slug,
            defaults={'name': name, 'display_name': display, 'calc_type': calc, 'service': 'delivery'},
        )
    for slug, name in UNITS:
        Unit.objects.update_or_create(slug=slug, defaults={'name': name})
    for slug, label, lo, hi in PREP_TIMES:
        PreparationTime.objects.update_or_create(
            slug=slug, defaults={'label': label, 'min_minutes': lo, 'max_minutes': hi}
        )
    for slug, label in SERVING_INFO:
        ServingInfo.objects.update_or_create(slug=slug, defaults={'label': label})
    for slug in MEAT_TYPES:
        MeatType.objects.update_or_create(slug=slug, defaults={'name': slug.title()})
    for slug, name in ALLERGENS:
        Allergen.objects.update_or_create(slug=slug, defaults={'name': name})
    for slug, name, tag_type, selection in TAGS:
        Tag.objects.update_or_create(
            slug=slug, defaults={'name': name, 'tag_type': tag_type, 'selection': selection}
        )


def unseed(apps, schema_editor):
    # Reference data — left in place on reverse to avoid cascading deletes
    # of menu items that reference it. No-op.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('menu', '0002_menu_glossary_redesign'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
