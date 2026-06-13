from django.http import JsonResponse
from django.views import View

from menu.services.menu_service import MenuService
from tables.models import Table


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
