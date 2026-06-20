import django.db.models.deletion
import django.utils.timezone
import uuid

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0006_restaurant_jwt_signing_secret'),
    ]

    operations = [
        migrations.CreateModel(
            name='StaffAttendance',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('clock_in_at', models.DateTimeField(auto_now_add=True)),
                ('clock_out_at', models.DateTimeField(blank=True, null=True)),
                (
                    'staff_user',
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name='attendances',
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    'location',
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name='attendances',
                        to='core.location',
                    ),
                ),
            ],
            options={
                'ordering': ['-clock_in_at'],
            },
        ),
    ]
