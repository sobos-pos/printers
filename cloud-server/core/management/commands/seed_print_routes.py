"""Usage: python manage.py seed_print_routes [--location <id>]

Creates PrintRoute rows for every Kitchen (KOT) and Section (BILL) at a
location when none exist yet.  Safe to re-run — uses get_or_create so
existing routes are never overwritten.  Intended for:

  • Bootstrapping existing installations after the routing-architecture
    migration that introduced Section and Kitchen models.
  • Setting up a fresh location quickly in production.
"""

from django.core.management.base import BaseCommand, CommandError

from core.models import Location, PrintRoute
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
        created_total = 0

        # KOT routes — one per Kitchen
        kitchens = Kitchen.objects.filter(location=location, is_active=True)
        if not kitchens.exists():
            self.stdout.write(self.style.WARNING('  No active kitchens found — skipping KOT routes'))
        for kitchen in kitchens:
            for ptype in ['KOT', 'BILL']:
                _, created = PrintRoute.objects.get_or_create(
                    location=location,
                    station_code=kitchen.code,
                    print_type=ptype,
                    defaults={'assigned_node': None},
                )
                if created:
                    self.stdout.write(f'  Created route: {kitchen.code} / {ptype}')
                    created_total += 1
                else:
                    self.stdout.write(f'  Exists:        {kitchen.code} / {ptype}')

        # BILL routes — one per Section
        sections = Section.objects.filter(location=location, is_active=True)
        if not sections.exists():
            self.stdout.write(self.style.WARNING('  No active sections found — skipping BILL routes'))
        for section in sections:
            _, created = PrintRoute.objects.get_or_create(
                location=location,
                station_code=section.code,
                print_type='BILL',
                defaults={'assigned_node': None},
            )
            if created:
                self.stdout.write(f'  Created route: {section.code} / BILL')
                created_total += 1
            else:
                self.stdout.write(f'  Exists:        {section.code} / BILL')

        self.stdout.write(self.style.SUCCESS(f'Done — {created_total} new route(s) created'))
