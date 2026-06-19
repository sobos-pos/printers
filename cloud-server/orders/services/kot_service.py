from collections import defaultdict

from orders.models import Order


class KOTService:

    @staticmethod
    def build_kot(order: Order) -> dict:
        """Group order items by Kitchen and return a routing-ready KOT payload.

        Resolution rule per item:
            item.kitchen.code  ??  item.category.kitchen.code  ??  'KITCHEN'

        One segment per kitchen → one KOT per kitchen printer.
        section_code on the payload drives the single BILL per order.
        """
        segments = defaultdict(list)

        for item in order.items.select_related(
            'menu_item__kitchen',
            'menu_item__category__kitchen',
            'variant',
        ).prefetch_related('modifiers__modifier'):
            # Item-level kitchen takes precedence; fall back to category kitchen.
            kitchen_code = (
                (item.menu_item.kitchen.code if item.menu_item.kitchen_id else None)
                or (item.menu_item.category.kitchen.code if item.menu_item.category.kitchen_id else None)
                or 'KITCHEN'
            )

            name = item.menu_item.name
            if item.variant:
                name = f'{name} ({item.variant.name})'

            segments[kitchen_code].append({
                'qty': item.quantity,
                'name': name,
                'mods': [m.modifier.name for m in item.modifiers.all()],
                'notes': item.notes,
            })

        # section_code drives BILL routing; falls back to 'COUNTER' for
        # takeaway / QR orders that have no table or unassigned table section.
        section_code = 'COUNTER'
        if order.table_id and order.table.section_id:
            section_code = order.table.section.code

        return {
            'order': str(order.id),
            'table': order.table.label if order.table else None,
            'section_code': section_code,
            'placed_at': order.created_at.isoformat(),
            'segments': [
                {'station': kitchen_code, 'lines': lines}
                for kitchen_code, lines in segments.items()
            ],
        }
