"""Staff "shift" JWT minting.

Layer 2 of the two-layer auth model: a staff member authenticates against the
cloud (online) and receives a short-lived HS256 JWT signed with their
restaurant's shared secret. Electron devices in that restaurant verify the
token entirely offline using the same secret (see the node's localAuthService).

The token is intentionally self-contained and stateless — there is no
server-side session to look up at the device. It carries just enough context
(user, restaurant, location, role) for the device to authorize the request.
"""

from datetime import timedelta

import jwt
from django.utils import timezone

# A full restaurant shift. Staff log in once (online) and work offline for the
# rest of the shift; the device keeps accepting the token until it expires.
TOKEN_TTL_HOURS = 12
ALGORITHM = 'HS256'
TOKEN_TYPE = 'staff_access'


class StaffTokenError(Exception):
    """Raised when a token cannot be minted (e.g. user has no restaurant)."""


def _restaurant_secret(restaurant) -> str:
    """Return the restaurant's signing secret, generating one if missing
    (e.g. for restaurants created before this field existed)."""
    if not restaurant.jwt_signing_secret:
        restaurant.rotate_jwt_secret()
    return restaurant.jwt_signing_secret


def mint_staff_token(user, ttl_hours: int = TOKEN_TTL_HOURS) -> dict:
    """Sign a staff shift token for ``user``.

    Returns ``{'access_token', 'expires_at' (iso), 'expires_in' (seconds)}``.
    Raises StaffTokenError if the user is not attached to a restaurant.
    """
    restaurant = user.restaurant
    if restaurant is None:
        raise StaffTokenError('User is not attached to a restaurant')

    now = timezone.now()
    expires_at = now + timedelta(hours=ttl_hours)
    payload = {
        'type': TOKEN_TYPE,
        'user_id': str(user.id),
        'username': user.username,
        'name': user.get_full_name() or user.username,
        'role': user.role,
        'restaurant_id': str(restaurant.id),
        'location_id': str(user.location_id) if user.location_id else None,
        'iat': int(now.timestamp()),
        'exp': int(expires_at.timestamp()),
    }
    token = jwt.encode(payload, _restaurant_secret(restaurant), algorithm=ALGORITHM)
    return {
        'access_token': token,
        'expires_at': expires_at.isoformat(),
        'expires_in': ttl_hours * 3600,
    }


def verify_staff_token(token: str, restaurant) -> dict:
    """Decode + verify a staff token against a restaurant's secret.

    Mirrors the node's offline verification; used by tests and any server-side
    consumer. Raises jwt.PyJWTError subclasses on failure.
    """
    payload = jwt.decode(
        token,
        restaurant.jwt_signing_secret,
        algorithms=[ALGORITHM],
        options={'require': ['exp', 'iat']},
    )
    if payload.get('type') != TOKEN_TYPE:
        raise jwt.InvalidTokenError('Not a staff access token')
    if payload.get('restaurant_id') != str(restaurant.id):
        raise jwt.InvalidTokenError('restaurant_id mismatch')
    return payload
