"""
python manage.py wipe_data

Wipes all restaurant / menu / order / node data so you can start fresh.
Superuser accounts (is_superuser=True) are preserved by default.

Options:
  --yes              Skip the confirmation prompt.
  --wipe-glossary    Also delete global reference tables (TaxGroup, Tag,
                     Charge, PreparationTime, Unit, ServingInfo, MeatType,
                     Allergen). These are re-seeded by the data migrations
                     so you can restore them with: python manage.py migrate
                     followed by python manage.py seed_demo (optional).
  --wipe-superusers  Also delete superuser accounts.
"""

from django.core.management.base import BaseCommand
from django.db import transaction


class Command(BaseCommand):
    help = 'Wipe all restaurant/menu/order/node data. Start fresh.'

    def add_arguments(self, parser):
        parser.add_argument('--yes', action='store_true', help='Skip confirmation prompt')
        parser.add_argument(
            '--wipe-glossary', action='store_true',
            help='Also wipe global reference tables (TaxGroup, Tag, etc.)',
        )
        parser.add_argument(
            '--wipe-superusers', action='store_true',
            help='Also delete superuser (is_superuser=True) accounts',
        )

    def handle(self, *args, **options):
        yes = options['yes']
        wipe_glossary = options['wipe_glossary']
        wipe_superusers = options['wipe_superusers']

        self.stdout.write(self.style.WARNING('\n[!] WIPE DATA -- this is irreversible!\n'))
        self.stdout.write('Will delete:')
        self.stdout.write('  - All restaurants, locations, branches')
        self.stdout.write('  - All staff users (non-superusers)')
        self.stdout.write('  - All orders, order items')
        self.stdout.write('  - All menu categories, items, variants, modifiers')
        self.stdout.write('  - All tables, printer stations, print routes')
        self.stdout.write('  - All nodes, node configs, leases')
        self.stdout.write('  - All sync outbox / audit logs')
        self.stdout.write('  - All staff attendance records')
        if wipe_glossary:
            self.stdout.write('  - All global glossary data (TaxGroup, Tag, etc.)')
        if wipe_superusers:
            self.stdout.write('  - Superuser accounts')
        else:
            self.stdout.write('  [keep] Superuser accounts will be KEPT')
        self.stdout.write('')
        self.stdout.write(self.style.NOTICE(
            'After this, delete main-node/data/node.sqlite too '
            'and use "Reset Node Config" in the node app.'
        ))
        self.stdout.write('')

        if not yes:
            confirm = input('Type "wipe" to confirm: ').strip()
            if confirm != 'wipe':
                self.stdout.write(self.style.ERROR('Aborted.'))
                return

        with transaction.atomic():
            self._wipe(wipe_glossary, wipe_superusers)

        self.stdout.write(self.style.SUCCESS('\n[OK] All data wiped. Ready for a fresh start.'))
        self.stdout.write('')
        self.stdout.write('Next steps:')
        self.stdout.write('  1. Delete main-node/data/node.sqlite')
        self.stdout.write('  2. python manage.py seed_demo   (optional demo data)')
        self.stdout.write('     -- OR create a restaurant via the super admin panel')

    def _wipe(self, wipe_glossary: bool, wipe_superusers: bool) -> None:
        from orders.models import Order
        from tables.models import Table
        from menu.models import (
            MenuCategory, MenuVersion, ModerationRecord,
            PrinterStation, TaxGroup, Tax, TaxGroupTax,
            Tag, Charge, Unit, PreparationTime, ServingInfo, MeatType, Allergen,
        )
        from core.models import (
            Restaurant, Location, StaffUser, LocationNode, LocationLease,
            NodeConfig, PrintRoute, SyncOutbox, SyncLog, StaffAttendance,
        )
        try:
            from super_admin.models import StaffInvitation
            _has_invitation = True
        except ImportError:
            _has_invitation = False

        def drop(qs, label):
            n, _ = qs.delete()
            self.stdout.write(f'  deleted {n:>6}  {label}')

        # 1. Detach superusers from restaurants so cascade doesn't kill them.
        if not wipe_superusers:
            StaffUser.objects.filter(is_superuser=True).update(
                restaurant=None, location=None
            )

        # 2. Attendance
        drop(StaffAttendance.objects.all(), 'StaffAttendance')

        # 3. Orders (must go before MenuItems which have PROTECT FK)
        drop(Order.objects.all(), 'Order + OrderItem + OrderItemModifier (cascade)')

        # 4. Sync data
        drop(SyncOutbox.objects.all(), 'SyncOutbox')
        drop(SyncLog.objects.all(), 'SyncLog')

        # 5. Node data
        drop(PrintRoute.objects.all(), 'PrintRoute')
        drop(NodeConfig.objects.all(), 'NodeConfig')
        drop(LocationLease.objects.all(), 'LocationLease')
        drop(LocationNode.objects.all(), 'LocationNode')

        # 6. Moderation records
        drop(ModerationRecord.objects.all(), 'ModerationRecord')

        # 7. Invitations (references Location + StaffUser)
        if _has_invitation:
            drop(StaffInvitation.objects.all(), 'StaffInvitation')

        # 8. Non-superuser staff users
        if wipe_superusers:
            drop(StaffUser.objects.all(), 'StaffUser (all)')
        else:
            drop(StaffUser.objects.filter(is_superuser=False), 'StaffUser (non-superusers)')

        # 9. Menu structure (cascade: subcategory → item → variant → modifier)
        drop(MenuCategory.objects.all(), 'MenuCategory + items + variants + modifiers (cascade)')
        drop(PrinterStation.objects.all(), 'PrinterStation')
        drop(MenuVersion.objects.all(), 'MenuVersion')

        # 10. Tables
        drop(Table.objects.all(), 'Table')

        # 11. Location → Restaurant (cascade clears location-level leftovers)
        drop(Location.objects.all(), 'Location (cascade)')
        drop(Restaurant.objects.all(), 'Restaurant (cascade)')

        # 12. Optional: global glossary reference tables
        if wipe_glossary:
            drop(TaxGroupTax.objects.all(), 'TaxGroupTax')
            drop(TaxGroup.objects.all(), 'TaxGroup')
            drop(Tax.objects.all(), 'Tax')
            drop(Tag.objects.all(), 'Tag')
            drop(Charge.objects.all(), 'Charge')
            drop(Unit.objects.all(), 'Unit')
            drop(PreparationTime.objects.all(), 'PreparationTime')
            drop(ServingInfo.objects.all(), 'ServingInfo')
            drop(MeatType.objects.all(), 'MeatType')
            drop(Allergen.objects.all(), 'Allergen')
            self.stdout.write(self.style.NOTICE(
                '\n  Glossary wiped. Re-seed with: python manage.py migrate'
            ))
