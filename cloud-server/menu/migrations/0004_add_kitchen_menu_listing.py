import django.db.models.deletion
import uuid
from collections import Counter
from django.db import migrations, models


def backfill_kitchen_from_station(apps, schema_editor):
    """Create a Kitchen per existing PrinterStation and migrate item routing."""
    Kitchen = apps.get_model('menu', 'Kitchen')
    PrinterStation = apps.get_model('menu', 'PrinterStation')
    MenuItem = apps.get_model('menu', 'MenuItem')
    MenuCategory = apps.get_model('menu', 'MenuCategory')

    # One Kitchen per PrinterStation (same code and name).
    station_to_kitchen: dict = {}
    for station in PrinterStation.objects.all():
        kitchen, _ = Kitchen.objects.get_or_create(
            location=station.location,
            code=station.code,
            defaults={'name': station.name, 'is_active': True},
        )
        station_to_kitchen[station.pk] = kitchen

    # Copy item-level station → kitchen.
    for item in MenuItem.objects.filter(station__isnull=False).select_related('station'):
        kitchen = station_to_kitchen.get(item.station_id)
        if kitchen:
            MenuItem.objects.filter(pk=item.pk).update(kitchen=kitchen)

    # Derive category kitchen from the most common item kitchen in that category.
    for category in MenuCategory.objects.all():
        kitchen_ids = list(
            MenuItem.objects.filter(category=category, kitchen__isnull=False)
            .values_list('kitchen_id', flat=True)
        )
        if kitchen_ids:
            most_common_id = Counter(kitchen_ids).most_common(1)[0][0]
            MenuCategory.objects.filter(pk=category.pk).update(kitchen_id=most_common_id)


class Migration(migrations.Migration):

    dependencies = [
        ('menu', '0003_seed_glossary'),
        ('tables', '0002_add_section'),
        ('core', '0001_initial'),
    ]

    operations = [
        # Kitchen entity
        migrations.CreateModel(
            name='Kitchen',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('name', models.CharField(max_length=40)),
                ('code', models.CharField(max_length=20)),
                ('is_active', models.BooleanField(default=True)),
                ('location', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='kitchens', to='core.location')),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('location', 'code'), name='uniq_kitchen_code')],
            },
        ),
        # kitchen FK on MenuCategory (category-level default)
        migrations.AddField(
            model_name='menucategory',
            name='kitchen',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='categories',
                to='menu.kitchen',
            ),
        ),
        # kitchen FK on MenuItem (per-item override)
        migrations.AddField(
            model_name='menuitem',
            name='kitchen',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='items',
                to='menu.kitchen',
            ),
        ),
        # Backfill kitchen from existing station mapping
        migrations.RunPython(backfill_kitchen_from_station, migrations.RunPython.noop),
        # Menu entity (section-scoped catalogue)
        migrations.CreateModel(
            name='Menu',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('name', models.CharField(max_length=80)),
                ('is_active', models.BooleanField(default=True)),
                ('location', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='menus', to='core.location')),
            ],
        ),
        # SectionMenu M2M link
        migrations.CreateModel(
            name='SectionMenu',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('section', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='section_menus', to='tables.section')),
                ('menu', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='section_menus', to='menu.menu')),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('section', 'menu'), name='uniq_section_menu')],
            },
        ),
        # MenuListing M2M with price override
        migrations.CreateModel(
            name='MenuListing',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('price_override', models.DecimalField(blank=True, decimal_places=2, max_digits=10, null=True)),
                ('menu', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='listings', to='menu.menu')),
                ('item', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='listings', to='menu.menuitem')),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('menu', 'item'), name='uniq_menu_listing')],
            },
        ),
    ]
