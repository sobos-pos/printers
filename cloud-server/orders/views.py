import json

from django.http import JsonResponse
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator

from core.views import get_session_user
from orders.models import Order
from orders.serializers import serialize_order
from orders.services.kot_service import KOTService
from orders.services.order_service import OrderService


@method_decorator(csrf_exempt, name='dispatch')
class OrderCreateView(View):
    def post(self, request):
        try:
            data = json.loads(request.body)
            # Soft auth: if a valid staff token is present, attribute the order to
            # that user. Anonymous orders (QR customer flow) remain allowed.
            staff_user = get_session_user(request)
            order = OrderService.create_order(
                table_uuid=data['table_uuid'],
                source=data.get('source', Order.OrderSource.USER_APP_QR),
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
