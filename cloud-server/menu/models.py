from django.db import models

from core.models import BaseModel


class PrinterStation(BaseModel):
    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='stations'
    )
    name = models.CharField(max_length=40)
    code = models.CharField(max_length=20)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'code'], name='uniq_station_location_code'),
        ]

    def __str__(self):
        return f'{self.code} @ {self.location}'


class DietaryTag(BaseModel):
    label = models.CharField(max_length=30, unique=True)
    icon = models.CharField(max_length=30, blank=True)

    def __str__(self):
        return self.label


class MenuCategory(BaseModel):
    location = models.ForeignKey(
        'core.Location', on_delete=models.CASCADE, related_name='menu_categories'
    )
    name = models.CharField(max_length=80)
    display_order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ['display_order']

    def __str__(self):
        return f'{self.name} @ {self.location}'


class MenuItem(BaseModel):
    category = models.ForeignKey(
        MenuCategory, related_name='items', on_delete=models.CASCADE
    )
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    base_price = models.DecimalField(max_digits=10, decimal_places=2)
    is_available = models.BooleanField(default=True)
    station = models.ForeignKey(
        PrinterStation,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='menu_items',
    )
    image = models.ImageField(upload_to='menu/', blank=True)
    dietary_tags = models.ManyToManyField(DietaryTag, blank=True)

    def __str__(self):
        return self.name


class Variant(BaseModel):
    menu_item = models.ForeignKey(
        MenuItem, related_name='variants', on_delete=models.CASCADE
    )
    name = models.CharField(max_length=40)
    price_delta = models.DecimalField(max_digits=10, decimal_places=2, default=0)

    def __str__(self):
        return f'{self.menu_item.name} — {self.name}'


class ModifierGroup(BaseModel):
    menu_item = models.ForeignKey(
        MenuItem, related_name='modifier_groups', on_delete=models.CASCADE
    )
    name = models.CharField(max_length=80)
    min_select = models.PositiveIntegerField(default=0)
    max_select = models.PositiveIntegerField(default=1)

    def __str__(self):
        return f'{self.name} ({self.menu_item.name})'


class Modifier(BaseModel):
    group = models.ForeignKey(
        ModifierGroup, related_name='options', on_delete=models.CASCADE
    )
    name = models.CharField(max_length=80)
    price_delta = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    is_available = models.BooleanField(default=True)

    def __str__(self):
        return f'{self.name} (+{self.price_delta})'


class MenuVersion(BaseModel):
    location = models.OneToOneField(
        'core.Location', on_delete=models.CASCADE, related_name='menu_version'
    )
    version = models.BigIntegerField(default=0)

    def __str__(self):
        return f'MenuVersion {self.version} @ {self.location}'
