from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0008_locationnode_unique_node_id_global'),
    ]

    operations = [
        # Location geofence configuration.
        migrations.AddField(
            model_name='location',
            name='latitude',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='location',
            name='longitude',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='location',
            name='geofence_radius_m',
            field=models.PositiveIntegerField(default=200),
        ),
        # Attendance geolocation audit trail.
        migrations.AddField(
            model_name='staffattendance',
            name='clock_in_lat',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='staffattendance',
            name='clock_in_lng',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='staffattendance',
            name='clock_in_distance_m',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='staffattendance',
            name='clock_out_lat',
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='staffattendance',
            name='clock_out_lng',
            field=models.FloatField(blank=True, null=True),
        ),
    ]
