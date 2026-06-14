from django.core.exceptions import ValidationError
from django.http import JsonResponse
from django.views import View

from menu.services.menu_service import MenuService
from tables.models import Table


class TableListView(View):
    """GET /api/v1/tables/?location=<location_id> — active tables for a location.

    Powers the waiter app's table picker (the native app has no server-rendered
    template to inject tables into, unlike the QR/waiter HTML pages).
    """

    def get(self, request):
        location_id = request.GET.get('location')
        if not location_id:
            return JsonResponse(
                {'error': {'code': 'BAD_REQUEST', 'message': 'location query param is required'}},
                status=400,
            )
        try:
            tables = (
                Table.objects.filter(location_id=location_id, is_active=True)
                .order_by('label')
            )
        except (ValueError, ValidationError):
            return JsonResponse(
                {'error': {'code': 'BAD_REQUEST', 'message': 'Invalid location id'}},
                status=400,
            )
        return JsonResponse({
            'tables': [
                {'id': str(t.id), 'label': t.label, 'location': str(t.location_id)}
                for t in tables
            ]
        })


class TableMenuView(View):
    def get(self, request, table_uuid):
        try:
            data = MenuService.get_menu_for_table(str(table_uuid))
            return JsonResponse(data)
        except Table.DoesNotExist:
            return JsonResponse(
                {'error': {'code': 'NOT_FOUND', 'message': 'Table not found'}},
                status=404,
            )
