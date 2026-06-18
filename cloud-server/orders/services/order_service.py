from decimal import Decimal
import uuid

from django.db import transaction

from core.models import SyncOutbox
from core.services.sync_service import SyncService
from menu.models import MenuItem, Modifier, Variant
from orders.models import Order, OrderItem, OrderItemModifier
from tables.models import Table


class OrderService:

    @staticmethod
    @transaction.atomic
    def create_order(
        table_uuid: str,
        source: str,
        items: list,
        idempotency_key: str = '',
        order_id=None,
        customer_note: str = '',
        created_by=None,
    ) -> Order:
        """
        Validate, create Order + items, enqueue ORDER_CREATED in SyncOutbox.
        Idempotent: same idempotency_key returns existing order.
        """
        if idempotency_key:
            existing = Order.objects.filter(idempotency_key=idempotency_key).first()
            if existing:
                return existing

        table = Table.objects.select_related('location').get(id=table_uuid)
        location = table.location

        if created_by and created_by.location:
            if created_by.location != location:
                raise ValueError("You do not have access to place orders for this location.")

        order_kwargs = {
            'location': location,
            'table': table,
            'source': source,
            'status': Order.Status.PENDING,
            'total': Decimal('0'),
            'customer_note': customer_note or '',
            'created_by': created_by,
            'idempotency_key': idempotency_key or '',
        }
        if order_id:
            order_kwargs['id'] = uuid.UUID(str(order_id))

        order = Order.objects.create(**order_kwargs)

        menu_item_ids = [item_data['menu_item'] for item_data in items]
        variant_ids = [
            item_data['variant']
            for item_data in items
            if item_data.get('variant')
        ]
        modifier_ids = [
            mod_id
            for item_data in items
            for mod_id in item_data.get('modifiers', [])
        ]

        menu_items = {
            str(m.id): m
            for m in MenuItem.objects.filter(id__in=menu_item_ids).select_related(
                'station'
            )
        }
        variants = {
            str(v.id): v for v in Variant.objects.filter(id__in=variant_ids)
        } if variant_ids else {}
        modifiers = {
            str(m.id): m for m in Modifier.objects.filter(id__in=modifier_ids)
        } if modifier_ids else {}

        total = Decimal('0')
        for item_data in items:
            menu_item = menu_items[str(item_data['menu_item'])]
            variant = None

            if item_data.get('variant'):
                # Variants carry the absolute price (no item-level base price).
                variant = variants[str(item_data['variant'])]
                unit_price = variant.price
            else:
                # No variant chosen — price from the cheapest available variant.
                cheapest = (
                    menu_item.variants.filter(is_available=True)
                    .order_by('price')
                    .first()
                )
                unit_price = cheapest.price if cheapest else Decimal('0')

            order_item = OrderItem.objects.create(
                order=order,
                menu_item=menu_item,
                variant=variant,
                quantity=item_data.get('quantity', 1),
                unit_price=unit_price,
                notes=item_data.get('notes', ''),
            )

            line_unit = unit_price
            for mod_id in item_data.get('modifiers', []):
                mod = modifiers[str(mod_id)]
                OrderItemModifier.objects.create(
                    order_item=order_item,
                    modifier=mod,
                    price=mod.price,
                )
                line_unit += mod.price

            total += line_unit * order_item.quantity

        order.total = total
        order.save(update_fields=['total', 'updated_at'])

        order = OrderService.get_order(order.id)
        SyncService.enqueue(
            location,
            SyncOutbox.EventType.ORDER_CREATED,
            order.id,
            OrderService._serialize_order(order),
        )

        return order

    @staticmethod
    def get_order(order_uuid: str) -> Order:
        return (
            Order.objects.select_related('location', 'table', 'created_by')
            .prefetch_related(
                'items__menu_item__station',
                'items__variant',
                'items__modifiers__modifier',
            )
            .get(id=order_uuid)
        )

    @staticmethod
    def _serialize_order(order: Order) -> dict:
        """Full order payload written into SyncOutbox so the Node has everything."""
        items = []
        for item in order.items.all():
            items.append({
                'id': str(item.id),
                'menu_item_id': str(item.menu_item.id),
                'menu_item_name': item.menu_item.name,
                'station_code': item.menu_item.station.code
                if item.menu_item.station
                else None,
                'variant_id': str(item.variant.id) if item.variant else None,
                'variant_name': item.variant.name if item.variant else None,
                'quantity': item.quantity,
                'unit_price': str(item.unit_price),
                'notes': item.notes,
                'modifiers': [
                    {
                        'id': str(m.modifier.id),
                        'name': m.modifier.name,
                        'price': str(m.price),
                    }
                    for m in item.modifiers.all()
                ],
            })
        return {
            'id': str(order.id),
            'table_uuid': str(order.table.id) if order.table else None,
            'table_label': order.table.label if order.table else None,
            'source': order.source,
            'status': order.status,
            'total': str(order.total),
            'customer_note': order.customer_note,
            'created_by': str(order.created_by.id) if order.created_by else None,
            'created_at': order.created_at.isoformat(),
            'items': items,
        }
