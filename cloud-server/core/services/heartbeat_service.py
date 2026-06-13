from datetime import timedelta

from django.utils import timezone

from core.models import LocationNode


class HeartbeatService:

    @staticmethod
    def record(location, node_id: str, cluster_role: str = 'follower', node_label: str = '', station_codes=None, election_priority: int = 10, lan_host: str = '', lan_port: int = 3001, node_time=None, is_active: bool = False):
        """Update liveness. If this node is active and lease is vacant/expired/held by us, claim/renew it."""
        from core.services.active_lease_service import ActiveLeaseService

        if station_codes is None:
            station_codes = []

        node, created = LocationNode.objects.get_or_create(
            location=location,
            node_id=node_id,
            defaults={
                'cluster_role': cluster_role,
                'node_label': node_label,
                'station_codes': station_codes,
                'election_priority': election_priority,
                'lan_host': lan_host,
                'lan_port': lan_port,
                'is_online': True,
                'last_heartbeat_at': timezone.now(),
            }
        )

        if not created:
            node.cluster_role = cluster_role
            node.node_label = node_label
            node.station_codes = station_codes
            node.election_priority = election_priority
            node.lan_host = lan_host
            node.lan_port = lan_port
            node.is_online = True
            node.last_heartbeat_at = timezone.now()
            node.save()

        promotion_granted = False
        if node.promotion_pending:
            promotion_granted = True
            node.promotion_pending = False
            node.cluster_role = 'leader'
            node.save(update_fields=['promotion_pending', 'cluster_role'])

        lease_renewed = False
        if node.cluster_role == 'leader' or is_active:
            status = ActiveLeaseService.status(location)
            if status['holder'] == node_id:
                ActiveLeaseService.renew(location, node_id)
                lease_renewed = True
            else:
                granted, _ = ActiveLeaseService.claim(location, node_id, force=False)
                lease_renewed = granted

        lease_status = ActiveLeaseService.status(location)
        leader_info = None
        if lease_status['holder']:
            try:
                leader_node = LocationNode.objects.get(location=location, node_id=lease_status['holder'])
                leader_info = {
                    'node_id': leader_node.node_id,
                    'lan_host': leader_node.lan_host,
                    'lan_port': leader_node.lan_port,
                    'is_online': leader_node.is_online,
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
                'station_codes': p.station_codes,
                'lan_host': p.lan_host,
                'lan_port': p.lan_port,
                'is_online': p.is_online,
            })

        return {
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
