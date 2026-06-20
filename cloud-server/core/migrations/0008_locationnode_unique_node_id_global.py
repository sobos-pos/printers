from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0007_staffattendance'),
    ]

    operations = [
        # First remove duplicates, keeping the most-recently-created row per node_id.
        migrations.RunSQL(
            sql="""
                DELETE FROM core_locationnode
                WHERE id NOT IN (
                    SELECT MAX(id)
                    FROM core_locationnode
                    GROUP BY node_id
                );
            """,
            reverse_sql=migrations.RunSQL.noop,
        ),
        # Drop the old per-location unique constraint.
        migrations.RunSQL(
            sql="DROP INDEX IF EXISTS uniq_location_node;",
            reverse_sql=migrations.RunSQL.noop,
        ),
        # Add the new global unique constraint.
        migrations.AddConstraint(
            model_name='locationnode',
            constraint=models.UniqueConstraint(
                fields=['node_id'],
                name='uniq_node_id_global',
            ),
        ),
    ]
