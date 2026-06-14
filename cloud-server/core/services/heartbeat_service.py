from datetime import timedelta

from django.utils import timezone

from core.models import LocationNode

# A node is online if its freshness stamp is within this many seconds.
# Leader: last_heartbeat_at. Follower: cluster_reported_at (leader snapshot).
ONLINE_FRESHNESS_SECONDS = 90


def _is_fresh(node, now=None) -> bool:
    """Derive online status from freshness instead of the stored is_online flag."""
    now = now or timezone.now()
    stamp = node.last_heartbeat_at if node.cluster_role == 'leader' else node.cluster_reported_at
    if stamp is None:
        stamp = node.last_heartbeat_at
    if stamp is None:
        return False
    return (now - stamp).total_seconds() <= ONLINE_FRESHNESS_SECONDS


class HeartbeatService:

    @staticmethod
    def record(location, node_id: str, cluster_role: str = 'follower', node_label: str = '', lan_host: str = '', lan_port: int = 3001, node_time=None, is_active: bool = False):
        """Update liveness. If this node is active and lease is vacant/expired/held by us, claim/renew it."""
        from core.services.active_lease_service import ActiveLeaseService

        # Liveness only — the client's self-reported cluster_role is NOT trusted;
        # the authoritative role is derived from lease ownership below.
        node, created = LocationNode.objects.get_or_create(
            location=location,
            node_id=node_id,
            defaults={
                'cluster_role': 'follower',
                'node_label': node_label,
                'lan_host': lan_host,
                'lan_port': lan_port,
                'is_online': True,
                'last_heartbeat_at': timezone.now(),
            }
        )

        if not created:
            node.node_label = node_label
            node.lan_host = lan_host
            node.lan_port = lan_port
            node.is_online = True
            node.last_heartbeat_at = timezone.now()
            node.save(update_fields=[
                'node_label', 'lan_host', 'lan_port', 'is_online',
                'last_heartbeat_at', 'updated_at',
            ])

        # Manager-approved promotion was a v1 concept; always report no promotion
        # so the heartbeat response shape stays stable for clients.
        promotion_granted = False

        # A node that wants to be active claims/renews the lease. claim() also
        # demotes every other node, guaranteeing a single leader per location.
        lease_renewed = False
        if is_active:
            status = ActiveLeaseService.status(location)
            if status['holder'] == node_id:
                ActiveLeaseService.renew(location, node_id)
                lease_renewed = True
            else:
                granted, _ = ActiveLeaseService.claim(location, node_id, force=False)
                lease_renewed = granted

        lease_status = ActiveLeaseService.status(location)

        # Authoritative role = lease ownership. Correct this node's stored role so
        # an online node that lost (or never won) the lease self-demotes to follower.
        is_holder = bool(lease_status['holder'] == node_id and lease_status['is_fresh'])
        resolved_role = 'leader' if is_holder else 'follower'
        if node.cluster_role != resolved_role:
            node.cluster_role = resolved_role
            node.save(update_fields=['cluster_role', 'updated_at'])

        if is_holder:
            # Self-heal every leader beat: no other node may stay labelled leader
            # (covers a stale/offline ex-leader that never claims again).
            LocationNode.objects.filter(
                location=location, cluster_role='leader'
            ).exclude(node_id=node_id).update(cluster_role='follower')
        leader_info = None
        if lease_status['holder']:
            try:
                leader_node = LocationNode.objects.get(location=location, node_id=lease_status['holder'])
                leader_info = {
                    'node_id': leader_node.node_id,
                    'lan_host': leader_node.lan_host,
                    'lan_port': leader_node.lan_port,
                    'is_online': _is_fresh(leader_node),
                }
            except LocationNode.DoesNotExist:
                leader_info = {
                    'node_id': lease_status['holder'],
                    'lan_host': '',
                    'lan_port': 3001,
                    'is_online': False,
                }

        peers = []
        peer_nodes = LocationNode.objects.filter(location=location).exclude(node_id=node_id)
        for p in peer_nodes:
            peers.append({
                'node_id': p.node_id,
                'node_label': p.node_label,
                'cluster_role': p.cluster_role,
                'lan_host': p.lan_host,
                'lan_port': p.lan_port,
                'is_online': _is_fresh(p),
            })

        return {
            'role': resolved_role,
            'lease_renewed': lease_renewed,
            'promotion_granted': promotion_granted,
            'leader': leader_info,
            'peers': peers,
        }

    @staticmethod
    def sweep_offline():
        """Mark locations offline when no heartbeat for > 2 minutes."""
        cutoff = timezone.now() - timedelta(minutes=2)
        return LocationNode.objects.filter(
            is_online=True,
            last_heartbeat_at__lt=cutoff,
        ).update(is_online=False)
