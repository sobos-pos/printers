from django.core.exceptions import ValidationError
from django.http import JsonResponse
from django.views import View

from menu.services.menu_service import MenuService
from tables.models import Table


from core.views import get_session_user


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

        user = get_session_user(request)
        if user and user.location:
            if str(user.location.id) != str(location_id):
                return JsonResponse(
                    {'error': {'code': 'FORBIDDEN', 'message': 'You do not have access to this location.'}},
                    status=403,
                )

        try:
            tables = (
                Table.objects.filter(location_id=location_id, is_active=True)
                .select_related('section')
                .order_by('label')
            )
        except (ValueError, ValidationError):
            return JsonResponse(
                {'error': {'code': 'BAD_REQUEST', 'message': 'Invalid location id'}},
                status=400,
            )

        def serialize_table(t):
            row = {'id': str(t.id), 'label': t.label, 'location': str(t.location_id)}
            if t.section_id:
                row['section'] = {'code': t.section.code, 'name': t.section.name}
            return row

        return JsonResponse({'tables': [serialize_table(t) for t in tables]})


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
