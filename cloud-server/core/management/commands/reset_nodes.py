"""Usage: python manage.py reset_nodes [--reseed]"""

from django.core.management import call_command
from django.core.management.base import BaseCommand

from core.models import LocationLease, LocationNode, NodeConfig


class Command(BaseCommand):
    help = 'Delete all provisioned nodes (and leases/config backups). Use --reseed for a fresh seed_demo node.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--reseed',
            action='store_true',
            help='Run seed_demo after clearing nodes (creates one seed-node-1 + demo credentials)',
        )

    def handle(self, *args, **options):
        count = LocationNode.objects.count()
        LocationNode.objects.all().delete()
        NodeConfig.objects.all().delete()
        LocationLease.objects.all().update(active_holder='', active_lease_expires_at=None)

        self.stdout.write(self.style.SUCCESS(f'Deleted {count} node(s); leases and config backups cleared.'))

        if options['reseed']:
            call_command('seed_demo')
