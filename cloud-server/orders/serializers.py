def serialize_order(order) -> dict:
    items = []
    for item in order.items.all():
        items.append({
            'id': str(item.id),
            'menu_item': str(item.menu_item.id),
            'menu_item_name': item.menu_item.name,
            'variant': str(item.variant.id) if item.variant else None,
            'quantity': item.quantity,
            'unit_price': str(item.unit_price),
            'notes': item.notes,
            'modifiers': [
                {'id': str(m.modifier.id), 'name': m.modifier.name, 'price': str(m.price)}
                for m in item.modifiers.all()
            ],
        })
    return {
        'id': str(order.id),
        'location': str(order.location.id),
        'table': str(order.table.id) if order.table else None,
        'table_label': order.table.label if order.table else None,
        'source': order.source,
        'status': order.status,
        'total': str(order.total),
        'customer_note': order.customer_note,
        'created_at': order.created_at.isoformat(),
        'updated_at': order.updated_at.isoformat(),
        'items': items,
    }
