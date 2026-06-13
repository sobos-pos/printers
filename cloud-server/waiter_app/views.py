import json
from django.views.generic import TemplateView
from tables.models import Table


class PosPageView(TemplateView):
    """
    Serves the staff POS ordering page.
    Injects:
      - CLOUD_BASE_URL: the canonical cloud API base (for fallback mode)
      - NODE_BASE_URL:  from settings (the Electron Node's local IP) — used for probe
      - tables_json:    list of tables so the waiter can pick one without an extra API call
    """
    template_name = 'waiter_app/pos.html'

    def get_context_data(self, **kwargs):
        from django.conf import settings
        ctx = super().get_context_data(**kwargs)

        # Tables for dropdown — only location-aware in prod; for demo return all active
        tables = list(
            Table.objects.filter(is_active=True)
            .select_related('location__restaurant')
            .values('id', 'label', 'location__id', 'location__restaurant__name')
        )
        ctx['tables_json'] = json.dumps([
            {
                'id': str(t['id']),
                'label': t['label'],
                'location_id': str(t['location__id']),
                'restaurant_name': t['location__restaurant__name'],
            }
            for t in tables
        ])

        # The Node's local IP is configured in settings (or env) for the probe
        ctx['node_base_url'] = getattr(settings, 'NODE_BASE_URL', 'http://localhost:3001')
        ctx['cloud_base_url'] = getattr(settings, 'CLOUD_BASE_URL_PUBLIC', '/')
        return ctx
