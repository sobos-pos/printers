from orders.models import Order


TRANSITIONS = {
    Order.Status.PENDING: [Order.Status.CONFIRMED, Order.Status.CANCELLED],
    Order.Status.CONFIRMED: [Order.Status.PREPARING, Order.Status.CANCELLED],
    Order.Status.PREPARING: [Order.Status.READY, Order.Status.CANCELLED],
    Order.Status.READY: [Order.Status.SERVED, Order.Status.CANCELLED],
    Order.Status.SERVED: [],
    Order.Status.CANCELLED: [],
}


class OrderStateMachine:

    @staticmethod
    def can_transition(current: str, target: str) -> bool:
        return target in TRANSITIONS.get(current, [])

    @staticmethod
    def assert_transition(current: str, target: str):
        if not OrderStateMachine.can_transition(current, target):
            raise ValueError(f'Invalid transition: {current} → {target}')

    @staticmethod
    def apply(order: Order, new_status: str) -> bool:
        """Apply the transition if valid. Returns True if applied, False if ignored."""
        if order.status == new_status:
            return False
        if not OrderStateMachine.can_transition(order.status, new_status):
            return False
        order.status = new_status
        order.save(update_fields=['status', 'updated_at'])
        return True
