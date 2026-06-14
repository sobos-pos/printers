import hashlib
import secrets

from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from core.models import LocationNode


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode()).hexdigest()


class ApiKeyAuth(BaseAuthentication):
    """
    Authenticates requests carrying:
        Authorization: Api-Key <per-location raw key>

    Resolves the location from LocationNode.api_key_hash.
    Attaches location to request.auth so views can access it.
    """

    def authenticate(self, request):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Api-Key '):
            return None

        raw_key = auth_header[len('Api-Key '):]
        key_hash = hash_api_key(raw_key)

        try:
            node = LocationNode.objects.select_related('location').get(
                api_key_hash=key_hash
            )
        except LocationNode.DoesNotExist as exc:
            raise AuthenticationFailed('Invalid API key.') from exc

        return (None, node)

    @staticmethod
    def issue_key(location, node_id="seed-node-1", node_label="Seed Node", cluster_role="leader") -> str:
        """Generate a new API key for a location, store its hash, return the raw key."""
        raw_key = secrets.token_hex(32)
        key_hash = hash_api_key(raw_key)
        node, created = LocationNode.objects.get_or_create(
            location=location,
            node_id=node_id,
            defaults={
                'api_key_hash': key_hash,
                'node_label': node_label,
                'cluster_role': cluster_role,
            },
        )
        if not created:
            node.api_key_hash = key_hash
            node.save(update_fields=['api_key_hash', 'updated_at'])
        return raw_key
