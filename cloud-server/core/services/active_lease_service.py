from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from core.models import LocationNode, LocationLease

LEASE_DURATION_SECONDS = 90


class ActiveLeaseService:

    @staticmethod
    def status(location) -> dict:
        """Return the current HA lease status for a location."""
        try:
            lease = LocationLease.objects.get(location=location)
        except LocationLease.DoesNotExist:
            return {
                'holder': '',
                'lease_expires_at': None,
                'last_seen_seconds': None,
                'is_fresh': False,
            }

        now = timezone.now()
        is_fresh = bool(
            lease.active_holder
            and lease.active_lease_expires_at
            and lease.active_lease_expires_at > now
        )
        last_seen = None
        if lease.active_holder:
            try:
                node = LocationNode.objects.get(location=location, node_id=lease.active_holder)
                if node.last_heartbeat_at:
                    last_seen = int((now - node.last_heartbeat_at).total_seconds())
            except LocationNode.DoesNotExist:
                pass

        return {
            'holder': lease.active_holder,
            'lease_expires_at': lease.active_lease_expires_at.isoformat()
            if lease.active_lease_expires_at
            else None,
            'last_seen_seconds': last_seen,
            'is_fresh': is_fresh,
        }

    @staticmethod
    @transaction.atomic
    def claim(location, node_id: str, force: bool = False):
        """Atomic compare-and-set of active_holder. Returns (granted, detail)."""
        lease, _ = LocationLease.objects.select_for_update().get_or_create(
            location=location
        )
        now = timezone.now()
        lease_alive = (
            lease.active_holder
            and lease.active_lease_expires_at
            and lease.active_lease_expires_at > now
        )

        if lease_alive and lease.active_holder != node_id and not force:
            retry_secs = int((lease.active_lease_expires_at - now).total_seconds())
            return False, {
                'holder': lease.active_holder,
                'retry_after_seconds': retry_secs,
            }

        lease.active_holder = node_id
        lease.active_lease_expires_at = now + timedelta(seconds=LEASE_DURATION_SECONDS)
        lease.save(
            update_fields=['active_holder', 'active_lease_expires_at', 'updated_at']
        )
        return True, {'holder': node_id}

    @staticmethod
    def renew(location, node_id: str):
        """Extend the lease. Only applies if node_id is still the holder."""
        now = timezone.now()
        LocationLease.objects.filter(
            location=location,
            active_holder=node_id,
        ).update(active_lease_expires_at=now + timedelta(seconds=LEASE_DURATION_SECONDS))

    @staticmethod
    def is_holder(location, node_id: str) -> bool:
        """Fence check — True iff node_id is the current active holder."""
        if not node_id:
            return False
        try:
            lease = LocationLease.objects.get(location=location)
        except LocationLease.DoesNotExist:
            return False
        now = timezone.now()
        if not lease.active_holder or lease.active_holder != node_id:
            return False
        if not lease.active_lease_expires_at or lease.active_lease_expires_at <= now:
            return False
        return True
