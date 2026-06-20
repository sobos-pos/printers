import json

from django.http import JsonResponse
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator

from core.views import get_session_user
from orders.models import Order
from orders.serializers import serialize_order, serialize_order_summary
from orders.services.kot_service import KOTService
from orders.services.order_service import OrderService

STAFF_ORDER_SOURCES = {
    Order.OrderSource.STAFF_POS,
    Order.OrderSource.WAITER_APP,
}


@method_decorator(csrf_exempt, name='dispatch')
class OrderCreateView(View):
    """POST /api/v1/orders/ — create order. GET — list orders (owner/manager)."""

    def get(self, request):
        user = get_session_user(request)
        if user is None:
            return JsonResponse(
                {'error': {'code': 'UNAUTHORIZED', 'message': 'Login required'}},
                status=401,
            )
        if user.role not in ('owner', 'manager') and not user.is_superuser:
            return JsonResponse(
                {'error': {'code': 'FORBIDDEN', 'message': 'Owner or manager access required'}},
                status=403,
            )
        if not user.restaurant:
            return JsonResponse({'orders': []})

        qs = (
            Order.objects.filter(location__restaurant=user.restaurant)
            .select_related('table', 'location', 'created_by')
            .order_by('-created_at')
        )

        location_id = request.GET.get('location')
        if location_id:
            qs = qs.filter(location_id=location_id)

        status = request.GET.get('status')
        if status:
            qs = qs.filter(status=status)

        waiter_id = request.GET.get('waiter')
        if waiter_id:
            qs = qs.filter(created_by_id=waiter_id)

        limit = min(int(request.GET.get('limit', 100)), 500)
        orders = qs[:limit]
        return JsonResponse({
            'orders': [serialize_order_summary(o) for o in orders],
        })

    def post(self, request):
        try:
            data = json.loads(request.body)
            staff_user = get_session_user(request)
            source = data.get('source', Order.OrderSource.USER_APP_QR)
            if source in STAFF_ORDER_SOURCES and staff_user is None:
                return JsonResponse(
                    {
                        'error': {
                            'code': 'UNAUTHORIZED',
                            'message': 'Staff login required to place orders.',
                        }
                    },
                    status=401,
                )
            order = OrderService.create_order(
                table_uuid=data['table_uuid'],
                source=source,
                items=data.get('items', []),
                idempotency_key=request.headers.get('Idempotency-Key', ''),
                customer_note=data.get('customer_note', ''),
                created_by=staff_user,
            )
            order = OrderService.get_order(order.id)
            return JsonResponse(serialize_order(order), status=201)
        except (KeyError, Order.DoesNotExist, ValueError) as exc:
            return JsonResponse(
                {'error': {'code': 'BAD_REQUEST', 'message': str(exc)}},
                status=400,
            )
        except Exception as exc:
            return JsonResponse(
                {'error': {'code': 'BAD_REQUEST', 'message': str(exc)}},
                status=400,
            )


class OrderDetailView(View):
    def get(self, request, order_uuid):
        try:
            order = OrderService.get_order(str(order_uuid))
            return JsonResponse(serialize_order(order))
        except Order.DoesNotExist:
            return JsonResponse(
                {'error': {'code': 'NOT_FOUND', 'message': 'Order not found'}},
                status=404,
            )


class OrderKOTView(View):
    def get(self, request, order_uuid):
        try:
            order = OrderService.get_order(str(order_uuid))
            return JsonResponse(KOTService.build_kot(order))
        except Order.DoesNotExist:
            return JsonResponse(
                {'error': {'code': 'NOT_FOUND', 'message': 'Order not found'}},
                status=404,
            )
