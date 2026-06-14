import uuid

from django.db import models
from django.contrib.auth.models import AbstractUser


class BaseModel(models.Model):
    """Abstract base — UUIDv4 PK + timestamps. All models extend this."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Restaurant(BaseModel):
    name = models.CharField(max_length=120)
    legal_name = models.CharField(max_length=160, blank=True)
    contact_email = models.EmailField(blank=True)
    phone = models.CharField(max_length=20, blank=True)
    address = models.TextField(blank=True)
    tax_id = models.CharField(max_length=20, blank=True)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return self.name


class Location(BaseModel):
    restaurant = models.ForeignKey(
        Restaurant, related_name='locations', on_delete=models.CASCADE
    )
    name = models.CharField(max_length=120)
    address = models.TextField(blank=True)
    timezone = models.CharField(max_length=40, default='Asia/Kolkata')
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return f'{self.restaurant.name} — {self.name}'


class StaffUser(AbstractUser):
    restaurant = models.ForeignKey(
        Restaurant, related_name='staff_users', on_delete=models.CASCADE, null=True, blank=True
    )
    role = models.CharField(
        max_length=20,
        choices=[('owner', 'Owner'), ('manager', 'Manager'), ('staff', 'Staff')],
        default='staff'
    )

    def __str__(self):
        return f'{self.username} ({self.role})'


class LocationNode(BaseModel):
    """
    One row per Node (multiple per Location). Holds node configurations, liveness tracking,
    and pairing detail.
    """

    location = models.ForeignKey(
        Location, on_delete=models.CASCADE, related_name='nodes'
    )
    node_id = models.CharField(max_length=64)
    node_label = models.CharField(max_length=120, blank=True)
    cluster_role = models.CharField(max_length=20, default='follower')
    lan_host = models.CharField(max_length=45, blank=True)
    lan_port = models.IntegerField(default=3001)
    api_key_hash = models.CharField(max_length=128)
    last_heartbeat_at = models.DateTimeField(null=True, blank=True)
    is_online = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'node_id'], name='uniq_location_node'),
        ]

    def __str__(self):
        return f'Node {self.node_id} ({self.node_label}) @ {self.location}'


class PrintRoute(BaseModel):
    """
    Maps (location, station, print_type) → the child node that prints it.
    assigned_node NULL means unassigned → the leader prints locally.
    """

    class PrintType(models.TextChoices):
        KOT = 'KOT', 'KOT'
        BILL = 'BILL', 'Bill'

    location = models.ForeignKey(
        Location, on_delete=models.CASCADE, related_name='print_routes'
    )
    station_code = models.CharField(max_length=20)
    print_type = models.CharField(max_length=8, choices=PrintType.choices)
    assigned_node = models.ForeignKey(
        LocationNode,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='print_routes',
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['location', 'station_code', 'print_type'],
                name='uniq_print_route',
            ),
        ]

    def __str__(self):
        return f'{self.station_code}/{self.print_type} → {self.assigned_node_id or "local"} @ {self.location}'


class LocationLease(BaseModel):
    """
    Separated lease model. Prevents split-brain by holding the active leader lease.
    """

    location = models.OneToOneField(
        Location, on_delete=models.CASCADE, related_name='lease'
    )
    active_holder = models.CharField(max_length=64, blank=True)
    active_lease_expires_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f'Lease for {self.location}'


class SyncOutbox(BaseModel):
    """Append-only event log per location. Unacked rows = pending work for the Node."""

    class EventType(models.TextChoices):
        ORDER_CREATED = 'ORDER_CREATED', 'Order Created'
        STATUS_CHANGED = 'STATUS_CHANGED', 'Status Changed'
        MENU_UPDATED = 'MENU_UPDATED', 'Menu Updated'

    location = models.ForeignKey(
        Location, on_delete=models.CASCADE, db_index=True, related_name='outbox_events'
    )
    sequence = models.BigIntegerField(db_index=True)
    event_type = models.CharField(max_length=20, choices=EventType.choices)
    order_ref = models.UUIDField(null=True, db_index=True)
    payload = models.JSONField()
    acked_at = models.DateTimeField(null=True, blank=True)
    acked_by_node = models.CharField(max_length=64, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'sequence'], name='uniq_outbox_location_seq'),
        ]
        indexes = [
            models.Index(fields=['location', 'acked_at', 'sequence']),
        ]

    def __str__(self):
        return f'{self.event_type} seq={self.sequence} @ {self.location}'


class SyncLog(BaseModel):
    """Audit trail of every sync pull/push attempt — separate from SyncOutbox."""

    class Direction(models.TextChoices):
        PULL = 'PULL', 'Pull'
        PUSH = 'PUSH', 'Push'

    class SyncType(models.TextChoices):
        QR_ORDER_PULL = 'QR_ORDER_PULL', 'QR Order Pull'
        STATUS_UPDATE_PUSH = 'STATUS_UPDATE_PUSH', 'Status Update Push'
        OFFLINE_ORDER_PUSH = 'OFFLINE_ORDER_PUSH', 'Offline Order Push'
        MENU_SYNC = 'MENU_SYNC', 'Menu Sync'

    class Status(models.TextChoices):
        PENDING = 'PENDING', 'Pending'
        SUCCESS = 'SUCCESS', 'Success'
        FAILED = 'FAILED', 'Failed'
        RETRYING = 'RETRYING', 'Retrying'

    direction = models.CharField(max_length=10, choices=Direction.choices)
    sync_type = models.CharField(max_length=30, choices=SyncType.choices)
    source = models.CharField(max_length=30)
    target = models.CharField(max_length=30)
    payload_ref = models.UUIDField(null=True, blank=True)
    status = models.CharField(max_length=15, choices=Status.choices)
    attempt_count = models.PositiveIntegerField(default=0)
    error_message = models.TextField(blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f'{self.sync_type} {self.direction} → {self.status}'


class NodeConfig(BaseModel):
    """Opaque JSON blob backup of a Node's local printer config."""

    location = models.ForeignKey(
        Location, on_delete=models.CASCADE, related_name='node_configs'
    )
    node_id = models.CharField(max_length=64)
    config = models.JSONField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['location', 'node_id'], name='uniq_node_config'),
        ]

    def __str__(self):
        return f'Config for node={self.node_id} @ {self.location}'
