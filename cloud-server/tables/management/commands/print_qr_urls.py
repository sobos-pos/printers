from django.core.management.base import BaseCommand
from django.conf import settings
from tables.models import Table

class Command(BaseCommand):
    help = 'Print QR code URLs for all active tables'

    def handle(self, *args, **options):
        base = getattr(settings, 'SITE_BASE_URL', 'http://localhost:8000')
        tables = Table.objects.filter(is_active=True).select_related('location__restaurant')
        for table in tables:
            url = f'{base}/order/{table.id}/'
            self.stdout.write(f'{table.location.restaurant.name} | {table.label}: {url}')
