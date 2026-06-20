from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0010_remove_locationnode_uniq_location_node'),
    ]

    operations = [
        migrations.AddField(
            model_name='staffattendance',
            name='clock_out_distance_m',
            field=models.FloatField(blank=True, null=True),
        ),
    ]
