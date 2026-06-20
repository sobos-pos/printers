"""Write-side menu operations for the management API.

Every mutation runs in a transaction and ends by bumping the location's
MenuVersion (which enqueues MENU_UPDATED in the SyncOutbox), so connected
nodes re-pull the menu and refresh their local cache.
"""

import base64
import binascii
import io
import uuid
from decimal import Decimal, InvalidOperation

from django.core.files.base import ContentFile
from django.db import transaction
from PIL import Image, UnidentifiedImageError

from menu.models import (
    Allergen,
    CatalogueKind,
    Charge,
    MeatType,
    MenuCategory,
    MenuItem,
    MenuItemMedia,
    MenuSubCategory,
    Modifier,
    ModifierGroup,
    PreparationTime,
    PrinterStation,
    ServingInfo,
    Tag,
    TaxGroup,
    Unit,
    Variant,
    VariantCharge,
)
from menu.services.menu_service import MenuService


class MenuValidationError(Exception):
    """Raised on bad input — mapped to HTTP 400 by the view."""


def _dec(value, field):
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise MenuValidationError(f'{field} must be a number')


def _decode_image(image, field='image') -> ContentFile:
    """Decode a data URL / raw base64 string into a validated image file.

    Accepts ``data:image/png;base64,<...>`` or a bare base64 string. Raises
    MenuValidationError on malformed input or a non-image payload.
    """
    if not isinstance(image, str) or not image.strip():
        raise MenuValidationError(f'{field} must be a base64 image string')
    raw = image.strip()
    if raw.startswith('data:'):
        try:
            raw = raw.split(',', 1)[1]
        except IndexError:
            raise MenuValidationError(f'{field} is not a valid data URL')
    try:
        blob = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise MenuValidationError(f'{field} is not valid base64')
    if not blob:
        raise MenuValidationError(f'{field} is empty')

    # Validate it is a real image and detect the format with Pillow (imghdr was
    # removed in Python 3.13). verify() guards against corrupt/spoofed payloads;
    # it can raise several exception types (incl. SyntaxError) for bad files.
    try:
        fmt = (Image.open(io.BytesIO(blob)).format or '').lower()
        Image.open(io.BytesIO(blob)).verify()
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise MenuValidationError('Image must be a PNG, JPEG, GIF or WebP file')
    if fmt not in {'png', 'jpeg', 'gif', 'webp'}:
        raise MenuValidationError('Image must be a PNG, JPEG, GIF or WebP file')
    ext = 'jpg' if fmt == 'jpeg' else fmt
    return ContentFile(blob, name=f'{uuid.uuid4().hex}.{ext}')


class MenuAdminService:
    # -- reference data ----------------------------------------------------

    @staticmethod
    def glossary(location) -> dict:
        """Reference values + this location's stations, for form dropdowns."""
        def tag_rows(tag_type):
            return [
                {'slug': t.slug, 'name': t.name, 'selection': t.selection}
                for t in Tag.objects.filter(tag_type=tag_type, is_active=True)
            ]

        return {
            'tags': {
                'dietary': tag_rows(Tag.TagType.DIETARY),
                'misc': tag_rows(Tag.TagType.MISC),
                'legal': tag_rows(Tag.TagType.LEGAL),
                'info': tag_rows(Tag.TagType.INFO),
                'gst': tag_rows(Tag.TagType.GST),
                'cake_flavor': tag_rows(Tag.TagType.CAKE_FLAVOR),
                'cake_type': tag_rows(Tag.TagType.CAKE_TYPE),
            },
            'tax_groups': [
                {'slug': g.slug, 'name': g.name, 'rate': str(g.rate)}
                for g in TaxGroup.objects.filter(is_active=True)
            ],
            'charges': [
                {'slug': c.slug, 'name': c.name, 'calc_type': c.calc_type}
                for c in Charge.objects.filter(is_active=True)
            ],
            'units': [{'slug': u.slug, 'name': u.name} for u in Unit.objects.all()],
            'preparation_times': [
                {'slug': p.slug, 'label': p.label} for p in PreparationTime.objects.all()
            ],
            'serving_info': [
                {'slug': s.slug, 'label': s.label} for s in ServingInfo.objects.all()
            ],
            'meat_types': [{'slug': m.slug, 'name': m.name} for m in MeatType.objects.all()],
            'allergens': [{'slug': a.slug, 'name': a.name} for a in Allergen.objects.all()],
            'kinds': [{'value': k.value, 'label': k.label} for k in CatalogueKind],
            'stations': [
                {'code': s.code, 'name': s.name}
                for s in PrinterStation.objects.filter(location=location)
            ],
        }

    # -- management tree ---------------------------------------------------

    @staticmethod
    def tree(location, request=None) -> dict:
        """Full menu for editing — includes unavailable items/variants.

        When ``request`` is provided, image URLs are returned as absolute URIs
        so the Electron renderer can display them directly.
        """
        categories = (
            MenuCategory.objects.filter(location=location)
            .prefetch_related(
                'subcategories',
                'items__variants__tax_group',
                'items__variants__portion_unit',
                'items__tags',
                'items__modifier_groups__options',
                'items__media',
                'items__station',
            )
            .order_by('display_order')
        )
        out = []
        for cat in categories:
            out.append({
                'id': str(cat.id),
                'name': cat.name,
                'display_order': cat.display_order,
                'is_active': cat.is_active,
                'image': MenuAdminService._abs_url(cat.image, request),
                'subcategories': [
                    {'id': str(s.id), 'name': s.name} for s in cat.subcategories.all()
                ],
                'items': [MenuAdminService._item_summary(i, request) for i in cat.items.all()],
            })
        return {'categories': out}

    @staticmethod
    def _abs_url(filefield, request):
        if not filefield:
            return None
        url = filefield.url
        return request.build_absolute_uri(url) if request is not None else url

    @staticmethod
    def _item_summary(item, request=None) -> dict:
        return {
            'id': str(item.id),
            'name': item.name,
            'description': item.description,
            'kind': item.kind,
            'is_available': item.is_available,
            'station': item.station.code if item.station else None,
            'media': [
                {
                    'id': str(m.id),
                    'url': MenuAdminService._abs_url(m.image, request),
                    'is_primary': m.is_primary,
                }
                for m in item.media.all()
            ],
            'tags': [t.slug for t in item.tags.all()],
            'variants': [
                {
                    'id': str(v.id),
                    'name': v.name,
                    'price': str(v.price),
                    'tax_group': v.tax_group.slug if v.tax_group else None,
                    'is_available': v.is_available,
                }
                for v in item.variants.all()
            ],
            'modifier_groups': [
                {
                    'id': str(g.id),
                    'name': g.name,
                    'min_selection': g.min_selection,
                    'max_selection': g.max_selection,
                    'options': [
                        {'id': str(o.id), 'name': o.name, 'price': str(o.price)}
                        for o in g.options.all()
                    ],
                }
                for g in item.modifier_groups.all()
            ],
        }

    # -- writes ------------------------------------------------------------

    @staticmethod
    @transaction.atomic
    def create_category(location, data: dict) -> MenuCategory:
        name = (data.get('name') or '').strip()
        if not name:
            raise MenuValidationError('Category name is required')
        cat = MenuCategory.objects.create(
            location=location,
            name=name,
            description=data.get('description', ''),
            display_order=data.get('display_order', 0),
        )
        if data.get('image'):
            cat.image = _decode_image(data['image'], 'category image')
            cat.save(update_fields=['image', 'updated_at'])
        MenuService.bump_version(location)
        return cat

    @staticmethod
    @transaction.atomic
    def create_item(location, data: dict) -> MenuItem:
        name = (data.get('name') or '').strip()
        if not name:
            raise MenuValidationError('Item name is required')

        category = MenuAdminService._get_category(location, data.get('category_id'))

        subcategory = None
        if data.get('subcategory_id'):
            subcategory = MenuSubCategory.objects.filter(
                id=data['subcategory_id'], category=category
            ).first()

        kind = data.get('kind') or CatalogueKind.DEFAULT
        if kind not in CatalogueKind.values:
            raise MenuValidationError(f'Unknown kind: {kind}')

        variants = data.get('variants') or []
        if not variants:
            raise MenuValidationError('At least one variant (with a price) is required')

        station = None
        if data.get('station_code'):
            station = PrinterStation.objects.filter(
                location=location, code=data['station_code']
            ).first()

        item = MenuItem.objects.create(
            category=category,
            subcategory=subcategory,
            name=name,
            description=data.get('description', ''),
            kind=kind,
            station=station,
            preparation_time=MenuAdminService._lookup(PreparationTime, data.get('preparation_time')),
            serving_info=MenuAdminService._lookup(ServingInfo, data.get('serving_info')),
            box_rows=data.get('box_rows'),
            box_columns=data.get('box_columns'),
            display_order=data.get('display_order', 0),
        )
        item.full_clean(exclude=['category'])  # validates box-fixed-piece grid etc.

        MenuAdminService._set_tags(item, location, data.get('tags') or [])
        MenuAdminService._set_meta_m2m(item, data)
        MenuAdminService._create_variants(item, variants)
        MenuAdminService._create_groups(item, data.get('modifier_groups') or [])
        MenuAdminService._create_media(item, data)

        MenuService.bump_version(location)
        return item

    @staticmethod
    @transaction.atomic
    def add_item_media(location, item_id: str, image) -> MenuItemMedia:
        item = MenuItem.objects.filter(id=item_id, category__location=location).first()
        if not item:
            raise MenuValidationError('Item not found')
        is_first = not item.media.exists()
        media = MenuItemMedia.objects.create(
            menu_item=item,
            image=_decode_image(image),
            is_primary=is_first,
            display_order=item.media.count(),
        )
        MenuService.bump_version(location)
        return media

    @staticmethod
    @transaction.atomic
    def delete_media(location, media_id: str) -> None:
        media = MenuItemMedia.objects.filter(
            id=media_id, menu_item__category__location=location
        ).first()
        if not media:
            raise MenuValidationError('Image not found')
        item = media.menu_item
        was_primary = media.is_primary
        media.delete()
        # Promote another image to primary if we removed the primary one.
        if was_primary:
            nxt = item.media.order_by('display_order').first()
            if nxt:
                nxt.is_primary = True
                nxt.save(update_fields=['is_primary', 'updated_at'])
        MenuService.bump_version(location)

    @staticmethod
    @transaction.atomic
    def update_item(location, item_id: str, data: dict) -> MenuItem:
        item = MenuItem.objects.filter(id=item_id, category__location=location).first()
        if not item:
            raise MenuValidationError('Item not found')

        if 'name' in data:
            name = (data.get('name') or '').strip()
            if not name:
                raise MenuValidationError('Item name cannot be empty')
            item.name = name
        if 'description' in data:
            item.description = data['description']
        if 'is_available' in data:
            item.is_available = bool(data['is_available'])
        if 'station_code' in data:
            item.station = PrinterStation.objects.filter(
                location=location, code=data['station_code']
            ).first()
        if data.get('category_id'):
            item.category = MenuAdminService._get_category(location, data['category_id'])
        item.save()

        if 'tags' in data:
            MenuAdminService._set_tags(item, location, data.get('tags') or [])

        MenuService.bump_version(location)
        return item

    @staticmethod
    @transaction.atomic
    def delete_item(location, item_id: str) -> None:
        item = MenuItem.objects.filter(id=item_id, category__location=location).first()
        if not item:
            raise MenuValidationError('Item not found')
        item.delete()
        MenuService.bump_version(location)

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _get_category(location, category_id):
        category = MenuCategory.objects.filter(id=category_id, location=location).first()
        if not category:
            raise MenuValidationError('Category not found for this location')
        return category

    @staticmethod
    def _lookup(model, slug):
        if not slug:
            return None
        return model.objects.filter(slug=slug).first()

    @staticmethod
    def _set_tags(item, location, slugs):
        tags = list(Tag.objects.filter(slug__in=slugs, is_active=True))
        dietary = [t for t in tags if t.tag_type == Tag.TagType.DIETARY]
        if len(dietary) > 1:
            raise MenuValidationError('Only one dietary tag (veg/non-veg/egg) is allowed')
        item.tags.set(tags)

    @staticmethod
    def _set_meta_m2m(item, data):
        if data.get('meat_types'):
            item.meat_types.set(MeatType.objects.filter(slug__in=data['meat_types']))
        if data.get('allergens'):
            item.allergens.set(Allergen.objects.filter(slug__in=data['allergens']))

    @staticmethod
    def _create_variants(item, variants):
        for idx, v in enumerate(variants):
            vname = (v.get('name') or '').strip()
            if not vname:
                raise MenuValidationError('Each variant needs a name')
            variant = Variant.objects.create(
                menu_item=item,
                name=vname,
                price=_dec(v.get('price', 0), 'variant price'),
                tax_group=MenuAdminService._lookup(TaxGroup, v.get('tax_group')),
                portion_value=_dec(v['portion_value'], 'portion_value')
                if v.get('portion_value') not in (None, '')
                else None,
                portion_unit=MenuAdminService._lookup(Unit, v.get('portion_unit')),
                display_order=idx,
            )
            for c in v.get('charges') or []:
                charge = MenuAdminService._lookup(Charge, c.get('slug'))
                if charge:
                    VariantCharge.objects.create(
                        variant=variant, charge=charge, value=_dec(c.get('value', 0), 'charge value')
                    )

    @staticmethod
    def _create_media(item, data):
        # Accept a single `image` and/or a list of `images` (base64/data URLs).
        images = list(data.get('images') or [])
        if data.get('image'):
            images.insert(0, data['image'])
        for idx, img in enumerate(images):
            MenuItemMedia.objects.create(
                menu_item=item,
                image=_decode_image(img),
                is_primary=(idx == 0),
                display_order=idx,
            )

    @staticmethod
    def _create_groups(item, groups, parent_option=None):
        for gidx, g in enumerate(groups):
            gname = (g.get('name') or '').strip()
            if not gname:
                raise MenuValidationError('Each modifier group needs a name')
            group = ModifierGroup.objects.create(
                menu_item=item if parent_option is None else None,
                parent_option=parent_option,
                name=gname,
                slug=g.get('slug', ''),
                min_selection=g.get('min_selection', 0),
                max_selection=g.get('max_selection', 1),
                required=bool(g.get('required', False)),
                display_order=gidx,
            )
            for oidx, o in enumerate(g.get('options') or []):
                oname = (o.get('name') or '').strip()
                if not oname:
                    raise MenuValidationError('Each modifier option needs a name')
                option = Modifier.objects.create(
                    group=group,
                    name=oname,
                    price=_dec(o.get('price', 0), 'option price'),
                    is_default=bool(o.get('is_default', False)),
                    kind=o.get('kind', ''),
                    display_order=oidx,
                )
                # Recurse for nested option groups (arbitrary depth).
                MenuAdminService._create_groups(
                    item, o.get('nested_option_groups') or [], parent_option=option
                )
