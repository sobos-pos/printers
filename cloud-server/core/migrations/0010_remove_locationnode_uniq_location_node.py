from django.db import migrations


class Migration(migrations.Migration):
    """Reconcile migration STATE only.

    Migration 0008 dropped the old `uniq_location_node` index from the database
    via raw SQL (and added the new global `uniq_node_id_global` constraint), but
    it never removed the old constraint from Django's migration state. This makes
    the autodetector think the model still has it. Remove it from state only — the
    database index was already dropped in 0008, so no DB operation is needed.
    """

    dependencies = [
        ('core', '0009_geofence_attendance_geo'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.RemoveConstraint(
                    model_name='locationnode',
                    name='uniq_location_node',
                ),
            ],
        ),
    ]
