from django.db import transaction
from django.utils import timezone

from core.models import SyncOutbox, SyncLog


class SyncService:

    @staticmethod
    @transaction.atomic
    def enqueue(location, event_type: str, order_ref, payload: dict):
        """Allocate next per-location sequence and append a SyncOutbox row."""
        last = (
            SyncOutbox.objects.filter(location=location)
            .select_for_update()
            .order_by('-sequence')
            .values_list('sequence', flat=True)
            .first()
        )
        next_seq = (last or 0) + 1

        SyncOutbox.objects.create(
            location=location,
            sequence=next_seq,
            event_type=event_type,
            order_ref=order_ref,
            payload=payload,
        )

    @staticmethod
    def fetch_unacked(location, limit: int = 50, cursor: int = 0) -> dict:
        """Return unacked SyncOutbox events after cursor, ordered by sequence."""
        qs = (
            SyncOutbox.objects.filter(
                location=location,
                acked_at__isnull=True,
                sequence__gt=cursor,
            )
            .order_by('sequence')[: limit + 1]
        )

        events = list(qs)
        has_more = len(events) > limit
        events = events[:limit]

        serialized = [
            {
                'event_id': str(e.id),
                'sequence': e.sequence,
                'event_type': e.event_type,
                'order_ref': str(e.order_ref) if e.order_ref else None,
                'payload': e.payload,
            }
            for e in events
        ]

        return {
            'events': serialized,
            'next_cursor': events[-1].sequence if events else cursor,
            'has_more': has_more,
        }

    @staticmethod
    @transaction.atomic
    def ack(node_id: str, event_ids: list, location) -> int:
        """Mark events as acked. Idempotent — already-acked events are skipped."""
        now = timezone.now()
        count = SyncOutbox.objects.filter(
            id__in=event_ids,
            location=location,
            acked_at__isnull=True,
        ).update(acked_at=now, acked_by_node=node_id)

        SyncLog.objects.create(
            direction=SyncLog.Direction.PULL,
            sync_type=SyncLog.SyncType.QR_ORDER_PULL,
            source='local_main_node',
            target='cloud_server',
            status=SyncLog.Status.SUCCESS,
            attempt_count=1,
        )
        return count

    @staticmethod
    @transaction.atomic
    def apply_status_push(
        order_uuid: str,
        new_status: str,
        occurred_at=None,
        idempotency_key: str = '',
    ):
        """Apply status update pushed up by the Node. Monotonic — backward ignored."""
        from orders.models import Order
        from orders.services.order_state_machine import OrderStateMachine

        order = Order.objects.select_related('location', 'table').get(id=order_uuid)
        applied = OrderStateMachine.apply(order, new_status)

        if applied:
            SyncService.enqueue(
                order.location,
                SyncOutbox.EventType.STATUS_CHANGED,
                order.id,
                {'status': new_status},
            )
            SyncLog.objects.create(
                direction=SyncLog.Direction.PUSH,
                sync_type=SyncLog.SyncType.STATUS_UPDATE_PUSH,
                source='local_main_node',
                target='cloud_server',
                payload_ref=order.id,
                status=SyncLog.Status.SUCCESS,
                attempt_count=1,
            )

        return Order.objects.select_related('location', 'table').prefetch_related(
            'items__menu_item__station',
            'items__variant',
            'items__modifiers__modifier',
        ).get(id=order_uuid)

    @staticmethod
    @transaction.atomic
    def ingest_bulk(orders_data: list, idempotency_key: str = '') -> dict:
        """UUID-upsert offline-created orders. Existing UUID = no-op."""
        from orders.models import Order
        from orders.services.order_service import OrderService

        created = 0
        skipped = 0
        for order_data in orders_data:
            order_id = order_data.get('id')
            if order_id and Order.objects.filter(id=order_id).exists():
                skipped += 1
                continue
            OrderService.create_order(
                table_uuid=order_data['table_uuid'],
                source=Order.OrderSource.STAFF_POS,
                items=order_data.get('items', []),
                idempotency_key=str(order_id) if order_id else '',
                order_id=order_id,
            )
            created += 1

        SyncLog.objects.create(
            direction=SyncLog.Direction.PUSH,
            sync_type=SyncLog.SyncType.OFFLINE_ORDER_PUSH,
            source='local_main_node',
            target='cloud_server',
            status=SyncLog.Status.SUCCESS,
            attempt_count=1,
        )
        return {'created': created, 'skipped': skipped}
