"""Usage: python manage.py seed_print_routes [--location <id>]

Creates PrintRoute rows for every Kitchen (KOT) and Section (BILL) at a
location when none exist yet.  Safe to re-run — uses get_or_create so
existing routes are never overwritten.  Intended for:

  • Bootstrapping existing installations after the routing-architecture
    migration that introduced Section and Kitchen models.
  • Setting up a fresh location quickly in production.
"""

from django.core.management.base import BaseCommand, CommandError

from core.models import Location
from core.services.print_route_service import ensure_print_routes, remove_legacy_kitchen_bill_routes
from menu.models import Kitchen
from tables.models import Section


class Command(BaseCommand):
    help = 'Seed PrintRoute rows for all kitchens (KOT) and sections (BILL) at a location'

    def add_arguments(self, parser):
        parser.add_argument(
            '--location',
            metavar='UUID',
            help='Location UUID to seed (defaults to the only location if there is one)',
        )

    def handle(self, *args, **options):
        loc_id = options.get('location')
        if loc_id:
            try:
                location = Location.objects.get(id=loc_id)
            except Location.DoesNotExist:
                raise CommandError(f'Location {loc_id} not found')
        else:
            locations = list(Location.objects.all())
            if len(locations) == 1:
                location = locations[0]
            elif len(locations) == 0:
                raise CommandError('No locations in the database. Run seed_demo first.')
            else:
                ids = ', '.join(str(l.id) for l in locations)
                raise CommandError(
                    f'Multiple locations found — pass --location <uuid>. Options: {ids}'
                )

        self.stdout.write(f'Seeding print routes for location: {location} ({location.id})')

        removed = remove_legacy_kitchen_bill_routes(location)
        if removed:
            self.stdout.write(
                self.style.WARNING(f'  Removed {removed} erroneous kitchen-only BILL route(s)')
            )

        created_total = ensure_print_routes(location)

        for kitchen in Kitchen.objects.filter(location=location, is_active=True):
            self.stdout.write(f'  KOT route:  {kitchen.code}')
        for section in Section.objects.filter(location=location, is_active=True):
            self.stdout.write(f'  BILL route: {section.code}')

        self.stdout.write(self.style.SUCCESS(f'Done — {created_total} new route(s) created'))
