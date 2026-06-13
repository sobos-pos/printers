from collections import defaultdict

from orders.models import Order


class KOTService:

    @staticmethod
    def build_kot(order: Order) -> dict:
        """Group order items by PrinterStation and return routing-ready KOT payload."""
        segments = defaultdict(list)

        for item in order.items.select_related(
            'menu_item__station', 'variant'
        ).prefetch_related('modifiers__modifier'):
            station_code = (
                item.menu_item.station.code if item.menu_item.station else 'KITCHEN'
            )
            name = item.menu_item.name
            if item.variant:
                name = f'{name} ({item.variant.name})'

            segments[station_code].append({
                'qty': item.quantity,
                'name': name,
                'mods': [m.modifier.name for m in item.modifiers.all()],
                'notes': item.notes,
            })

        return {
            'order': str(order.id),
            'table': order.table.label if order.table else None,
            'placed_at': order.created_at.isoformat(),
            'segments': [
                {'station': station, 'lines': lines}
                for station, lines in segments.items()
            ],
        }
