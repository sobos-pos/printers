"""Menu management API.

All endpoints accept EITHER a node Api-Key OR a manager/owner Bearer session
(resolved by core.views.get_actor_location), and are scoped to the resolved
location. Writes bump the menu version so connected nodes re-sync.
"""

import json

from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from core.views import get_actor_location
from menu.services.menu_admin_service import MenuAdminService, MenuValidationError


def _body(request):
    try:
        return json.loads(request.body or '{}')
    except (ValueError, TypeError):
        return None


@method_decorator(csrf_exempt, name='dispatch')
class MenuGlossaryView(View):
    """GET /api/v1/menu/glossary/ — reference data for form dropdowns."""

    def get(self, request):
        location, err = get_actor_location(request)
        if err:
            return err
        return JsonResponse(MenuAdminService.glossary(location))


@method_decorator(csrf_exempt, name='dispatch')
class MenuTreeView(View):
    """GET /api/v1/menu/tree/ — full menu (incl. unavailable) for editing."""

    def get(self, request):
        location, err = get_actor_location(request)
        if err:
            return err
        return JsonResponse(MenuAdminService.tree(location, request))


@method_decorator(csrf_exempt, name='dispatch')
class MenuCategoriesView(View):
    """POST /api/v1/menu/categories/ — create a category."""

    def post(self, request):
        data = _body(request)
        if data is None:
            return JsonResponse({'error': 'Invalid request body'}, status=400)
        location, err = get_actor_location(request, data)
        if err:
            return err
        try:
            cat = MenuAdminService.create_category(location, data)
        except MenuValidationError as exc:
            return JsonResponse({'error': str(exc)}, status=400)
        return JsonResponse({'id': str(cat.id), 'name': cat.name}, status=201)


@method_decorator(csrf_exempt, name='dispatch')
class MenuItemsView(View):
    """POST /api/v1/menu/items/ — create an item (variants/tags/modifiers)."""

    def post(self, request):
        data = _body(request)
        if data is None:
            return JsonResponse({'error': 'Invalid request body'}, status=400)
        location, err = get_actor_location(request, data)
        if err:
            return err
        try:
            item = MenuAdminService.create_item(location, data)
        except MenuValidationError as exc:
            return JsonResponse({'error': str(exc)}, status=400)
        return JsonResponse({'id': str(item.id), 'name': item.name}, status=201)


@method_decorator(csrf_exempt, name='dispatch')
class MenuItemDetailView(View):
    """PATCH/DELETE /api/v1/menu/items/<uuid>/ — update or delete an item."""

    def patch(self, request, item_id):
        data = _body(request)
        if data is None:
            return JsonResponse({'error': 'Invalid request body'}, status=400)
        location, err = get_actor_location(request, data)
        if err:
            return err
        try:
            item = MenuAdminService.update_item(location, str(item_id), data)
        except MenuValidationError as exc:
            return JsonResponse({'error': str(exc)}, status=400)
        return JsonResponse({'id': str(item.id), 'name': item.name, 'is_available': item.is_available})

    def delete(self, request, item_id):
        location, err = get_actor_location(request)
        if err:
            return err
        try:
            MenuAdminService.delete_item(location, str(item_id))
        except MenuValidationError as exc:
            return JsonResponse({'error': str(exc)}, status=400)
        return JsonResponse({'deleted': True})


@method_decorator(csrf_exempt, name='dispatch')
class MenuItemMediaView(View):
    """POST /api/v1/menu/items/<uuid>/media/ — add an image (base64) to an item."""

    def post(self, request, item_id):
        data = _body(request)
        if data is None:
            return JsonResponse({'error': 'Invalid request body'}, status=400)
        location, err = get_actor_location(request, data)
        if err:
            return err
        try:
            media = MenuAdminService.add_item_media(location, str(item_id), data.get('image'))
        except MenuValidationError as exc:
            return JsonResponse({'error': str(exc)}, status=400)
        return JsonResponse({
            'id': str(media.id),
            'url': request.build_absolute_uri(media.image.url),
            'is_primary': media.is_primary,
        }, status=201)


@method_decorator(csrf_exempt, name='dispatch')
class MenuMediaDetailView(View):
    """DELETE /api/v1/menu/media/<uuid>/ — remove an item image."""

    def delete(self, request, media_id):
        location, err = get_actor_location(request)
        if err:
            return err
        try:
            MenuAdminService.delete_media(location, str(media_id))
        except MenuValidationError as exc:
            return JsonResponse({'error': str(exc)}, status=400)
        return JsonResponse({'deleted': True})
