from django.db import models

from core.models import BaseModel


class Section(BaseModel):
    """Floor / service zone. Drives BILL routing (section.code → BILL printer)
    and scopes which Menu is visible to tables in this section."""

    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='sections'
    )
    name = models.CharField(max_length=80)
    # Routing key used in PrintRoute rows with print_type=BILL.
    code = models.CharField(max_length=20)
    display_order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'code'], name='uniq_section_code'),
        ]

    def save(self, *args, **kwargs):
        self.code = self.code.upper()
        super().save(*args, **kwargs)

    def __str__(self):
        return f'{self.code} ({self.name}) @ {self.location}'


class Table(BaseModel):
    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='tables'
    )
    # Which section (floor) this table belongs to. Null = not yet assigned
    # (system falls back to 'COUNTER' for BILL routing until set).
    section = models.ForeignKey(
        Section,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='tables',
    )
    label = models.CharField(max_length=20)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'label'], name='uniq_table_location_label'),
        ]

    def __str__(self):
        return f'{self.label} @ {self.location}'
