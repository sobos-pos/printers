import django.db.models.deletion
import uuid
from django.db import migrations, models


def backfill_default_sections(apps, schema_editor):
    """Create one default Section per location and assign all existing tables to it."""
    Location = apps.get_model('core', 'Location')
    Section = apps.get_model('tables', 'Section')
    Table = apps.get_model('tables', 'Table')

    for location in Location.objects.all():
        section, _ = Section.objects.get_or_create(
            location=location,
            code='DEFAULT',
            defaults={'name': 'Main Floor', 'display_order': 0, 'is_active': True},
        )
        Table.objects.filter(location=location, section__isnull=True).update(section=section)


class Migration(migrations.Migration):

    dependencies = [
        ('tables', '0001_initial'),
        ('core', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='Section',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('name', models.CharField(max_length=80)),
                ('code', models.CharField(max_length=20)),
                ('display_order', models.PositiveIntegerField(default=0)),
                ('is_active', models.BooleanField(default=True)),
                ('location', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='sections', to='core.location')),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('location', 'code'), name='uniq_section_code')],
            },
        ),
        migrations.AddField(
            model_name='table',
            name='section',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='tables',
                to='tables.section',
            ),
        ),
        migrations.RunPython(backfill_default_sections, migrations.RunPython.noop),
    ]
