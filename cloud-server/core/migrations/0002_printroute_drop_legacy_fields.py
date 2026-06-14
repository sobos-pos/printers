import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0001_initial'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='locationnode',
            name='station_codes',
        ),
        migrations.RemoveField(
            model_name='locationnode',
            name='election_priority',
        ),
        migrations.RemoveField(
            model_name='locationnode',
            name='promotion_pending',
        ),
        migrations.CreateModel(
            name='PrintRoute',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('station_code', models.CharField(max_length=20)),
                ('print_type', models.CharField(choices=[('KOT', 'KOT'), ('BILL', 'Bill')], max_length=8)),
                ('assigned_node', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='print_routes', to='core.locationnode')),
                ('location', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='print_routes', to='core.location')),
            ],
            options={
                'abstract': False,
            },
        ),
        migrations.AddConstraint(
            model_name='printroute',
            constraint=models.UniqueConstraint(fields=('location', 'station_code', 'print_type'), name='uniq_print_route'),
        ),
    ]
