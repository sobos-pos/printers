"""Menu domain models.

The schema is modelled on the Zomato POS integration menu glossary
(see ``menu_management.md``) and is organised in four layers:

1. Glossary / reference lookup tables   — global, seeded constants
   (TaxGroup, Tax, Charge, Unit, PreparationTime, ServingInfo,
    MeatType, Allergen, Tag).
2. Menu structure                        — per-location catalogue
   (MenuCategory → MenuSubCategory → MenuItem → Variant) plus media.
3. Modifiers                             — recursive customisation tree
   (ModifierGroup ⇄ Modifier, nestable to arbitrary depth).
4. Operations                            — MenuVersion, PrinterStation,
   and the moderation pipeline (ModerationRecord).

Pricing follows the glossary model: every item carries one or more
Variants and each Variant holds an *absolute* price plus its own tax
group, portion and packaging charges. There is intentionally no
item-level base price.
"""

from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import models

from core.models import BaseModel


# ---------------------------------------------------------------------------
# Shared enums
# ---------------------------------------------------------------------------

class CalcType(models.TextChoices):
    PERCENTAGE = 'percentage', 'Percentage'
    FIXED = 'fixed', 'Fixed'


class ServiceMode(models.TextChoices):
    ALL = 'all', 'All'
    DELIVERY = 'delivery', 'Delivery'
    DINE_IN = 'dine_in', 'Dine-in'
    TAKEAWAY = 'takeaway', 'Takeaway'


class CatalogueKind(models.TextChoices):
    """Catalogue/option ``kind`` (glossary §2.8).

    Item-level kinds: DEFAULT, CELEBRATION_CAKE, BOX_FIXED_PIECE.
    Option-level kinds: the ``cake-*`` values, used on Modifier rows.
    """

    DEFAULT = 'default', 'Default'
    CELEBRATION_CAKE = 'celebration-cake', 'Celebration Cake'
    CAKE_MESSAGE_ON_THE_CAKE = 'cake-message-on-the-cake', 'Message on the cake'
    CAKE_MESSAGE_ON_BOTTOM = 'cake-message-on-bottom-of-cake', 'Message on bottom disc'
    CAKE_MESSAGE_ON_CHOCOLATE_DISC = 'cake-message-on-chocolate-disc', 'Message on chocolate disc'
    CAKE_BIRTHDAY_CANDLES = 'cake-birthday-candles', 'Birthday candles'
    CAKE_BIRTHDAY_KNIFE = 'cake-birthday-knife', 'Cake knife'
    CAKE_PARTY_POPPER = 'cake-party-popper', 'Party popper'
    BOX_FIXED_PIECE = 'box-fixed-piece', 'Box (fixed piece)'


# ---------------------------------------------------------------------------
# 1. Glossary / reference lookup tables (global, seeded)
# ---------------------------------------------------------------------------

class TaxGroup(BaseModel):
    """Top-level tax identifier assigned to a variant (glossary §2.1)."""

    slug = models.SlugField(max_length=64, unique=True)
    name = models.CharField(max_length=60)
    calc_type = models.CharField(max_length=12, choices=CalcType.choices, default=CalcType.PERCENTAGE)
    rate = models.DecimalField(max_digits=6, decimal_places=2)
    service = models.CharField(max_length=12, choices=ServiceMode.choices, default=ServiceMode.ALL)
    is_active = models.BooleanField(default=True)
    # Resolved component taxes (glossary §2.3)
    taxes = models.ManyToManyField('Tax', through='TaxGroupTax', related_name='tax_groups', blank=True)

    class Meta:
        ordering = ['slug']

    def __str__(self):
        return self.slug


class Tax(BaseModel):
    """Individual tax line item shown on the bill (glossary §2.2)."""

    slug = models.SlugField(max_length=64, unique=True)
    name = models.CharField(max_length=60)
    display_name = models.CharField(max_length=60, blank=True)
    calc_type = models.CharField(max_length=12, choices=CalcType.choices, default=CalcType.PERCENTAGE)
    rate = models.DecimalField(max_digits=6, decimal_places=2)
    service = models.CharField(max_length=12, choices=ServiceMode.choices, default=ServiceMode.ALL)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['slug']
        verbose_name_plural = 'taxes'

    def __str__(self):
        return self.slug


class TaxGroupTax(BaseModel):
    """Mapping row: which individual taxes a tax group resolves into."""

    tax_group = models.ForeignKey(TaxGroup, on_delete=models.CASCADE, related_name='group_taxes')
    tax = models.ForeignKey(Tax, on_delete=models.CASCADE, related_name='tax_groups_links')

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['tax_group', 'tax'], name='uniq_taxgroup_tax'),
        ]

    def __str__(self):
        return f'{self.tax_group.slug} → {self.tax.slug}'


class Charge(BaseModel):
    """Extra fee (packaging) applied for a service mode (glossary §2.5)."""

    slug = models.SlugField(max_length=64, unique=True)
    name = models.CharField(max_length=60)
    display_name = models.CharField(max_length=60, blank=True)
    calc_type = models.CharField(max_length=12, choices=CalcType.choices, default=CalcType.FIXED)
    service = models.CharField(max_length=12, choices=ServiceMode.choices, default=ServiceMode.DELIVERY)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['slug']

    def __str__(self):
        return self.slug


class Unit(BaseModel):
    """Portion-size unit (glossary §2.7)."""

    slug = models.SlugField(max_length=20, unique=True)
    name = models.CharField(max_length=40)

    class Meta:
        ordering = ['slug']

    def __str__(self):
        return self.slug


class PreparationTime(BaseModel):
    """Predefined prep-time bucket (glossary §2.6)."""

    slug = models.SlugField(max_length=20, unique=True)
    label = models.CharField(max_length=40)
    min_minutes = models.PositiveIntegerField(null=True, blank=True)
    max_minutes = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        ordering = ['min_minutes']

    def __str__(self):
        return self.slug


class ServingInfo(BaseModel):
    """How many people one order serves (glossary §2.11)."""

    slug = models.SlugField(max_length=20, unique=True)
    label = models.CharField(max_length=40)

    class Meta:
        ordering = ['slug']

    def __str__(self):
        return self.slug


class MeatType(BaseModel):
    """Meat type for non-veg items (glossary §2.9)."""

    slug = models.SlugField(max_length=20, unique=True)
    name = models.CharField(max_length=40)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.slug


class Allergen(BaseModel):
    """Allergen present in an item (glossary §2.10)."""

    slug = models.SlugField(max_length=20, unique=True)
    name = models.CharField(max_length=80)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.slug


class Tag(BaseModel):
    """Catalogue tag (glossary §2.4).

    Replaces the old ``DietaryTag``. ``tag_type`` groups tags and
    ``selection`` records whether the group is single- or multi-select
    (validation enforced on the item, not in the DB).
    """

    class TagType(models.TextChoices):
        DIETARY = 'dietary', 'Dietary'
        MISC = 'misc', 'Miscellaneous'
        LEGAL = 'legal', 'Legally Sensitive'
        INFO = 'info', 'Info'
        GST = 'gst', 'GST Classification'
        CAKE_FLAVOR = 'cake_flavor', 'Cake Flavor'
        CAKE_TYPE = 'cake_type', 'Cake Type'

    class Selection(models.TextChoices):
        SINGLE = 'single', 'Single-select'
        MULTI = 'multi', 'Multi-select'

    slug = models.SlugField(max_length=60, unique=True)
    name = models.CharField(max_length=60)
    tag_type = models.CharField(max_length=16, choices=TagType.choices, default=TagType.MISC)
    selection = models.CharField(max_length=8, choices=Selection.choices, default=Selection.MULTI)
    icon = models.CharField(max_length=30, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['tag_type', 'slug']

    def __str__(self):
        return self.slug


# ---------------------------------------------------------------------------
# 4. Operations: printer stations and kitchens
# ---------------------------------------------------------------------------

class PrinterStation(BaseModel):
    """Physical print destination (maps to a node/printer via PrintRoute).
    Kept for backward compatibility; KOT routing now uses Kitchen.code."""

    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='stations'
    )
    name = models.CharField(max_length=40)
    code = models.CharField(max_length=20)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'code'], name='uniq_station_location_code'),
        ]

    def __str__(self):
        return f'{self.code} @ {self.location}'


class Kitchen(BaseModel):
    """Where dishes are cooked. Drives KOT routing (kitchen.code → KOT printer).

    Resolution rule per item: item.kitchen.code ?? category.kitchen.code ?? 'KITCHEN'
    """

    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='kitchens'
    )
    name = models.CharField(max_length=40)
    # Routing key used in PrintRoute rows with print_type=KOT.
    code = models.CharField(max_length=20)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'code'], name='uniq_kitchen_code'),
        ]

    def save(self, *args, **kwargs):
        self.code = self.code.upper()
        super().save(*args, **kwargs)

    def __str__(self):
        return f'{self.code} ({self.name}) @ {self.location}'


# ---------------------------------------------------------------------------
# 2. Menu structure (per location)
# ---------------------------------------------------------------------------

class MenuCategory(BaseModel):
    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='menu_categories'
    )
    name = models.CharField(max_length=80)
    description = models.TextField(blank=True)
    display_order = models.PositiveIntegerField(default=0)
    # Default kitchen for every item in this category. Per-item kitchen overrides this.
    kitchen = models.ForeignKey(
        Kitchen,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='categories',
    )
    # Prep time may be set at category level and inherited by items.
    preparation_time = models.ForeignKey(
        PreparationTime, null=True, blank=True, on_delete=models.SET_NULL, related_name='+'
    )
    image = models.ImageField(upload_to='menu/categories/', blank=True)
    is_active = models.BooleanField(default=True)
    external_id = models.CharField(max_length=128, blank=True, db_index=True)

    class Meta:
        ordering = ['display_order']
        indexes = [models.Index(fields=['location', 'is_active'])]

    def __str__(self):
        return f'{self.name} @ {self.location}'


class MenuSubCategory(BaseModel):
    """Optional grouping layer between a category and its items (§2.13)."""

    category = models.ForeignKey(
        MenuCategory, on_delete=models.CASCADE, related_name='subcategories'
    )
    name = models.CharField(max_length=80)
    description = models.TextField(blank=True)
    display_order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    external_id = models.CharField(max_length=128, blank=True, db_index=True)

    class Meta:
        ordering = ['display_order']
        constraints = [
            models.UniqueConstraint(fields=['category', 'name'], name='uniq_subcategory_name'),
        ]

    def __str__(self):
        return f'{self.category.name} → {self.name}'


class MenuItem(BaseModel):
    """A catalogue entry. Item placement: directly on a category, or on a
    sub-category when one is used (§2.13)."""

    category = models.ForeignKey(
        MenuCategory, related_name='items', on_delete=models.CASCADE
    )
    subcategory = models.ForeignKey(
        MenuSubCategory,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='items',
    )
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    kind = models.CharField(
        max_length=40, choices=CatalogueKind.choices, default=CatalogueKind.DEFAULT
    )
    station = models.ForeignKey(
        PrinterStation,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='menu_items',
    )
    # Per-item kitchen override. Falls back to category.kitchen when null.
    kitchen = models.ForeignKey(
        Kitchen,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='items',
    )
    preparation_time = models.ForeignKey(
        PreparationTime, null=True, blank=True, on_delete=models.SET_NULL, related_name='+'
    )
    serving_info = models.ForeignKey(
        ServingInfo, null=True, blank=True, on_delete=models.SET_NULL, related_name='+'
    )

    # Classification (§2.4, §2.9, §2.10)
    tags = models.ManyToManyField(Tag, blank=True, related_name='items')
    meat_types = models.ManyToManyField(MeatType, blank=True, related_name='items')
    allergens = models.ManyToManyField(Allergen, blank=True, related_name='items')

    # Nutrition metadata (§2.12 moderable meta keys)
    calorie_count = models.PositiveIntegerField(null=True, blank=True)
    protein_count = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)
    carbohydrate_count = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)
    fat_count = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)
    fiber_count = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)

    # box-fixed-piece metadata (§2.8) — mandatory for that kind, else null.
    box_rows = models.PositiveSmallIntegerField(null=True, blank=True)
    box_columns = models.PositiveSmallIntegerField(null=True, blank=True)

    display_order = models.PositiveIntegerField(default=0)
    is_available = models.BooleanField(default=True)
    external_id = models.CharField(max_length=128, blank=True, db_index=True)

    class Meta:
        ordering = ['display_order']
        indexes = [
            models.Index(fields=['category', 'is_available']),
            models.Index(fields=['kind']),
        ]

    def __str__(self):
        return self.name

    def clean(self):
        # box-fixed-piece requires a grid (§2.8).
        if self.kind == CatalogueKind.BOX_FIXED_PIECE and (
            self.box_rows is None or self.box_columns is None
        ):
            raise ValidationError('box-fixed-piece items require box_rows and box_columns.')


class MenuItemMedia(BaseModel):
    """One image among possibly several for an item (MEDIA moderation)."""

    menu_item = models.ForeignKey(MenuItem, on_delete=models.CASCADE, related_name='media')
    image = models.ImageField(upload_to='menu/items/')
    display_order = models.PositiveIntegerField(default=0)
    is_primary = models.BooleanField(default=False)
    external_id = models.CharField(max_length=128, blank=True, db_index=True)

    class Meta:
        ordering = ['display_order']

    def __str__(self):
        return f'media[{self.display_order}] for {self.menu_item.name}'


class Variant(BaseModel):
    """A portion/size option. Carries the *absolute* price plus its own
    tax group, portion and packaging charges (§2.1, §2.7)."""

    menu_item = models.ForeignKey(
        MenuItem, related_name='variants', on_delete=models.CASCADE
    )
    name = models.CharField(max_length=40)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    tax_group = models.ForeignKey(
        TaxGroup, null=True, blank=True, on_delete=models.SET_NULL, related_name='variants'
    )
    portion_value = models.DecimalField(max_digits=8, decimal_places=2, null=True, blank=True)
    portion_unit = models.ForeignKey(
        Unit, null=True, blank=True, on_delete=models.SET_NULL, related_name='+'
    )
    display_order = models.PositiveIntegerField(default=0)
    is_available = models.BooleanField(default=True)
    external_id = models.CharField(max_length=128, blank=True, db_index=True)

    class Meta:
        ordering = ['display_order']

    def __str__(self):
        return f'{self.menu_item.name} — {self.name}'


class VariantCharge(BaseModel):
    """Per-variant packaging charge with an explicit value (§2.5)."""

    variant = models.ForeignKey(Variant, on_delete=models.CASCADE, related_name='charges')
    charge = models.ForeignKey(Charge, on_delete=models.PROTECT, related_name='variant_charges')
    value = models.DecimalField(max_digits=10, decimal_places=2)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['variant', 'charge'], name='uniq_variant_charge'),
        ]

    def __str__(self):
        return f'{self.charge.slug}={self.value} on {self.variant}'


# ---------------------------------------------------------------------------
# 3. Modifiers (recursive customisation tree, §2.14–2.16)
# ---------------------------------------------------------------------------

class ModifierGroup(BaseModel):
    """An option/modifier group. Attaches to *either* a MenuItem (top level)
    *or* a parent Modifier (nested) — exactly one of the two."""

    menu_item = models.ForeignKey(
        MenuItem,
        null=True,
        blank=True,
        related_name='modifier_groups',
        on_delete=models.CASCADE,
    )
    parent_option = models.ForeignKey(
        'Modifier',
        null=True,
        blank=True,
        related_name='nested_groups',
        on_delete=models.CASCADE,
    )
    name = models.CharField(max_length=80)
    # Stable slug for special groups (e.g. cake-message-placement).
    slug = models.SlugField(max_length=60, blank=True)
    min_selection = models.PositiveIntegerField(default=0)
    max_selection = models.PositiveIntegerField(default=1)
    required = models.BooleanField(default=False)
    display_order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ['display_order']
        constraints = [
            models.CheckConstraint(
                # Attached to an item XOR nested under an option.
                condition=(
                    models.Q(menu_item__isnull=False, parent_option__isnull=True)
                    | models.Q(menu_item__isnull=True, parent_option__isnull=False)
                ),
                name='modifiergroup_single_parent',
            ),
        ]

    def __str__(self):
        return self.name

    def clean(self):
        if self.max_selection < self.min_selection:
            raise ValidationError('max_selection cannot be less than min_selection.')


class Modifier(BaseModel):
    """A single selectable option inside a group. May itself open nested
    groups via the reverse ``nested_groups`` relation (§2.16)."""

    group = models.ForeignKey(
        ModifierGroup, related_name='options', on_delete=models.CASCADE
    )
    name = models.CharField(max_length=80)
    price = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal('0'))
    is_default = models.BooleanField(default=False)
    in_stock = models.BooleanField(default=True)
    # Special option kind (e.g. cake-message-on-the-cake).
    kind = models.CharField(max_length=40, choices=CatalogueKind.choices, blank=True)
    display_order = models.PositiveIntegerField(default=0)
    external_id = models.CharField(max_length=128, blank=True, db_index=True)

    class Meta:
        ordering = ['display_order']

    def __str__(self):
        return f'{self.name} (+{self.price})'


# ---------------------------------------------------------------------------
# 4. Operations: versioning + moderation
# ---------------------------------------------------------------------------

class MenuVersion(BaseModel):
    location = models.OneToOneField(
        'core.Location', on_delete=models.CASCADE, related_name='menu_version'
    )
    version = models.BigIntegerField(default=0)

    def __str__(self):
        return f'MenuVersion {self.version} @ {self.location}'


class ModerationRecord(BaseModel):
    """Tracks a single field/entity through the Zomato moderation pipeline
    (§2.12 / §5). ``entity_id`` references the moderated menu entity by its
    UUID; ``entity_type`` says which kind it is."""

    class EntityType(models.TextChoices):
        VARIANT_PRICE = 'VARIANT_PRICE', 'Variant Price'
        CATALOGUE = 'CATALOGUE', 'Catalogue'
        CATALOGUE_TAG = 'CATALOGUE_TAG', 'Catalogue Tag'
        CATALOGUE_NAME = 'CATALOGUE_NAME', 'Catalogue Name'
        CATALOGUE_DESC = 'CATALOGUE_DESC', 'Catalogue Description'
        CATALOGUE_META = 'CATALOGUE_META', 'Catalogue Metadata'
        MEDIA = 'MEDIA', 'Media'

    class Status(models.TextChoices):
        UNDER_REVIEW = 'UNDER_REVIEW', 'Under Review'
        APPROVED = 'APPROVED', 'Approved'
        REJECTED = 'REJECTED', 'Rejected'

    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='moderation_records'
    )
    entity_type = models.CharField(max_length=20, choices=EntityType.choices)
    entity_id = models.UUIDField(db_index=True)
    # For CATALOGUE_META: which meta key (e.g. allergen_types, portion_size).
    meta_key = models.CharField(max_length=40, blank=True)
    status = models.CharField(
        max_length=15, choices=Status.choices, default=Status.UNDER_REVIEW
    )
    reason = models.TextField(blank=True)
    # The submitted value snapshot (price, name, tag_slug, meta_value, media…).
    submitted_value = models.JSONField(null=True, blank=True)
    external_ref = models.CharField(max_length=128, blank=True, db_index=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=['location', 'status']),
            models.Index(fields=['entity_type', 'entity_id']),
        ]

    def __str__(self):
        return f'{self.entity_type} [{self.status}] {self.entity_id}'


# ---------------------------------------------------------------------------
# 5. Section-scoped menus (visibility axis)
# ---------------------------------------------------------------------------

class Menu(BaseModel):
    """A named catalogue/price-list that can be assigned to one or more sections.

    Items join menus via MenuListing (M2M) with an optional per-menu price override,
    so the same dish can be priced differently in Janatha Bar vs Premium Bar.
    """

    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='menus'
    )
    name = models.CharField(max_length=80)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return f'{self.name} @ {self.location}'


class SectionMenu(BaseModel):
    """Maps a Section to one or more Menus (many-to-many via this through table)."""

    section = models.ForeignKey(
        'tables.Section', on_delete=models.CASCADE, related_name='section_menus'
    )
    menu = models.ForeignKey(
        Menu, on_delete=models.CASCADE, related_name='section_menus'
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['section', 'menu'], name='uniq_section_menu'),
        ]

    def clean(self):
        # A menu with no listings produces a blank waiter screen — catch it early.
        if self.menu_id and not self.menu.listings.exists():
            raise ValidationError(
                f'Menu "{self.menu.name}" has no items. '
                'Add MenuListing rows before assigning it to a section.'
            )

    def __str__(self):
        return f'{self.section.code} → {self.menu.name}'


class MenuListing(BaseModel):
    """Item membership in a Menu with an optional price override.

    If price_override is null the item's cheapest variant price is shown as-is.
    If set, it replaces the displayed price for that menu (single-price items
    such as bar beverages that differ in cost between sections).
    """

    menu = models.ForeignKey(Menu, on_delete=models.CASCADE, related_name='listings')
    item = models.ForeignKey(MenuItem, on_delete=models.CASCADE, related_name='listings')
    price_override = models.DecimalField(
        max_digits=10, decimal_places=2, null=True, blank=True
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['menu', 'item'], name='uniq_menu_listing'),
        ]

    def __str__(self):
        override = f' @ ₹{self.price_override}' if self.price_override is not None else ''
        return f'{self.item.name} in {self.menu.name}{override}'
