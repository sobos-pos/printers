from django.db import models

from core.models import BaseModel


class Table(BaseModel):
    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='tables'
    )
    label = models.CharField(max_length=20)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'label'], name='uniq_table_location_label'),
        ]

    def __str__(self):
        return f'{self.label} @ {self.location}'
