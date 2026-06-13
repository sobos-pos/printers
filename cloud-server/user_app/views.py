from django.views.generic import TemplateView
from django.shortcuts import get_object_or_404
from tables.models import Table


class MenuPageView(TemplateView):
    """
    Serves the customer QR ordering page.
    The table_uuid comes from the URL and is injected into the template
    so JavaScript can immediately call GET /api/v1/tables/<uuid>/menu/.
    No menu data is fetched server-side — the template shell is returned,
    JS does the rest.
    """
    template_name = 'user_app/menu.html'

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        table_uuid = str(kwargs['table_uuid'])

        # Validate the table exists (returns 404 if not)
        table = get_object_or_404(Table, id=table_uuid, is_active=True)

        ctx['table_uuid'] = table_uuid
        ctx['table_label'] = table.label
        ctx['location_name'] = table.location.restaurant.name
        return ctx
