from core.models import NodeConfig


class NodeConfigService:

    @staticmethod
    def save(location, node_id: str, config: dict):
        NodeConfig.objects.update_or_create(
            location=location,
            node_id=node_id,
            defaults={'config': config},
        )

    @staticmethod
    def get(location, node_id: str) -> dict | None:
        try:
            nc = NodeConfig.objects.get(location=location, node_id=node_id)
            return nc.config
        except NodeConfig.DoesNotExist:
            return None
