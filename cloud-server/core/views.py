import json
import logging

from django.db import connection, models
from django.http import JsonResponse
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator

from core.authentication import ApiKeyAuth
from core.services.active_lease_service import ActiveLeaseService
from core.services.heartbeat_service import HeartbeatService
from core.services.node_config_service import NodeConfigService
from core.services.sync_service import SyncService
from menu.services.menu_service import MenuService

logger = logging.getLogger(__name__)

# A node is considered online if its freshness stamp is within this many seconds.
# Leader: last_heartbeat_at. Follower: cluster_reported_at (leader snapshot).
ONLINE_FRESHNESS_SECONDS = 90


def is_node_fresh(node, now=None) -> bool:
    """Derive online status from freshness AND the stored is_online flag.

    An explicit is_online=False (set by markOffline / clear-config) always wins,
    so nodes are immediately reclaimable in the setup wizard after a clean logout.
    Otherwise freshness is derived from the heartbeat timestamp so crashed nodes
    (which never send an offline signal) go stale after ONLINE_FRESHNESS_SECONDS.
    """
    # Explicit offline signal takes priority over any cached timestamp.
    if not node.is_online:
        return False

    from django.utils import timezone as _tz

    now = now or _tz.now()
    stamp = node.last_heartbeat_at if node.cluster_role == 'leader' else node.cluster_reported_at
    # Fall back to last_heartbeat_at for legacy rows that never received a snapshot.
    if stamp is None:
        stamp = node.last_heartbeat_at
    if stamp is None:
        return False
    return (now - stamp).total_seconds() <= ONLINE_FRESHNESS_SECONDS


def get_auth(request):
    """Returns (node, error_response). node is the LocationNode if authed."""
    auth = ApiKeyAuth()
    try:
        result = auth.authenticate(request)
    except Exception:
        return None, JsonResponse(
            {'error': {'code': 'UNAUTHORIZED', 'message': 'Invalid API key'}},
            status=401,
        )
    if result is None:
        return None, JsonResponse(
            {'error': {'code': 'UNAUTHORIZED', 'message': 'Api-Key required'}},
            status=401,
        )
    _, node = result
    return node, None


def require_active_holder(request, node):
    """Fence mutating sync calls to the current active lease holder."""
    node_id = request.headers.get('X-Node-Id', '')
    if not ActiveLeaseService.is_holder(node.location, node_id):
        return JsonResponse(
            {
                'error': {
                    'code': 'NOT_ACTIVE_HOLDER',
                    'message': 'Mutating sync calls require X-Node-Id of the active holder',
                    'details': ActiveLeaseService.status(node.location),
                }
            },
            status=409,
        )
    return None


class HealthCheckView(View):
    """GET /health/ — liveness/readiness probe for load balancers."""

    def get(self, request):
        try:
            connection.ensure_connection()
            db_ok = True
        except Exception:
            logger.exception('Health check DB connection failed')
            db_ok = False

        status = 200 if db_ok else 503
        return JsonResponse({'status': 'ok' if db_ok else 'degraded', 'database': db_ok}, status=status)


@method_decorator(csrf_exempt, name='dispatch')
class SyncOrdersPollView(View):
    def get(self, request):
        node, err = get_auth(request)
        if err:
            return err
        cursor = int(request.GET.get('cursor', 0))
        limit = min(int(request.GET.get('limit', 50)), 200)
        data = SyncService.fetch_unacked(node.location, limit=limit, cursor=cursor)
        return JsonResponse(data)


@method_decorator(csrf_exempt, name='dispatch')
class SyncOrdersAckView(View):
    def post(self, request):
        node, err = get_auth(request)
        if err:
            return err
        fence = require_active_holder(request, node)
        if fence:
            return fence
        data = json.loads(request.body)
        node_id = request.headers.get('X-Node-Id', '')
        count = SyncService.ack(node_id, data.get('event_ids', []), node.location)
        return JsonResponse({'acked': count})


@method_decorator(csrf_exempt, name='dispatch')
class SyncOrderStatusView(View):
    def patch(self, request, order_uuid):
        node, err = get_auth(request)
        if err:
            return err
        fence = require_active_holder(request, node)
        if fence:
            return fence
        data = json.loads(request.body)
        try:
            order = SyncService.apply_status_push(
                order_uuid=str(order_uuid),
                new_status=data['status'],
                occurred_at=data.get('occurred_at'),
                idempotency_key=request.headers.get('Idempotency-Key', ''),
            )
        except Exception as exc:
            from django.core.exceptions import ObjectDoesNotExist
            if isinstance(exc, ObjectDoesNotExist) or 'DoesNotExist' in type(exc).__name__:
                return JsonResponse(
                    {'error': {'code': 'NOT_FOUND', 'message': 'Order not found on cloud — it may not have synced yet'}},
                    status=404,
                )
            raise
        from orders.serializers import serialize_order

        return JsonResponse(serialize_order(order))


@method_decorator(csrf_exempt, name='dispatch')
class SyncOrdersBulkView(View):
    def post(self, request):
        node, err = get_auth(request)
        if err:
            return err
        fence = require_active_holder(request, node)
        if fence:
            return fence
        data = json.loads(request.body)
        result = SyncService.ingest_bulk(
            orders_data=data.get('orders', []),
            idempotency_key=request.headers.get('Idempotency-Key', ''),
        )
        return JsonResponse(result)


@method_decorator(csrf_exempt, name='dispatch')
class SyncHeartbeatView(View):
    def post(self, request):
        node, err = get_auth(request)
        if err:
            return err
        data = json.loads(request.body)
        result = HeartbeatService.record(
            location=node.location,
            node_id=data.get('node_id', ''),
            cluster_role=data.get('cluster_role', 'follower'),
            node_label=data.get('node_label', ''),
            lan_host=data.get('lan_host', ''),
            lan_port=data.get('lan_port', 3001),
            node_time=data.get('node_time'),
            is_active=data.get('is_active', False),
        )
        return JsonResponse({
            'status': 'ok',
            'role': result['role'],
            'lease_renewed': result['lease_renewed'],
            'promotion_granted': result['promotion_granted'],
            'leader': result['leader'],
            'peers': result['peers'],
        })


@method_decorator(csrf_exempt, name='dispatch')
class SyncClusterStateView(View):
    """POST /api/v1/sync/cluster-state/ — the leader pushes ONE consolidated
    snapshot of cluster membership/status. The cloud becomes a read-only mirror.

    Authenticated via the leader's Api-Key; the caller must be the current
    active lease holder (rejects a non-leader trying to report)."""

    def post(self, request):
        node, err = get_auth(request)
        if err:
            return err

        try:
            data = json.loads(request.body)
        except Exception:
            return JsonResponse({'error': 'Invalid request body'}, status=400)

        leader_id = data.get('leader_id', '')
        nodes = data.get('nodes', [])

        # Only the active lease holder may report cluster state.
        if not ActiveLeaseService.is_holder(node.location, leader_id):
            return JsonResponse(
                {
                    'error': {
                        'code': 'NOT_ACTIVE_HOLDER',
                        'message': 'Only the active lease holder may report cluster state',
                        'details': ActiveLeaseService.status(node.location),
                    }
                },
                status=409,
            )

        from django.utils import timezone
        from core.models import LocationNode

        now = timezone.now()
        updated = 0
        for entry in nodes:
            node_id = (entry.get('node_id') or '').strip()
            if not node_id:
                continue
            n, created = LocationNode.objects.get_or_create(
                location=node.location,
                node_id=node_id,
                defaults={'cluster_role': entry.get('cluster_role', 'follower')},
            )
            n.node_label = entry.get('node_label', n.node_label)
            n.cluster_role = entry.get('cluster_role', n.cluster_role)
            n.lan_host = entry.get('lan_host', n.lan_host)
            n.lan_port = entry.get('lan_port', n.lan_port)
            n.cluster_reported_at = now
            # Keep the stored flag for backward-compat; the displayed status is
            # always derived from freshness on read.
            n.is_online = str(entry.get('status', '')).upper() == 'ONLINE'
            n.save(update_fields=[
                'node_label', 'cluster_role', 'lan_host', 'lan_port',
                'cluster_reported_at', 'is_online', 'updated_at',
            ])
            updated += 1

        return JsonResponse({'updated': updated})


@method_decorator(csrf_exempt, name='dispatch')
class SyncMenuView(View):
    def get(self, request):
        node, err = get_auth(request)
        if err:
            return err
        since_version = int(request.GET.get('since_version', 0))
        snapshot = MenuService.get_menu_snapshot(node.location, since_version)
        if snapshot is None:
            return JsonResponse({'changed': False, 'version': since_version})
        return JsonResponse(snapshot)


@method_decorator(csrf_exempt, name='dispatch')
class SyncActiveStatusView(View):
    def get(self, request):
        node, err = get_auth(request)
        if err:
            return err
        data = ActiveLeaseService.status(node.location)
        return JsonResponse(data)


@method_decorator(csrf_exempt, name='dispatch')
class SyncClaimActiveView(View):
    def post(self, request):
        node, err = get_auth(request)
        if err:
            return err
        data = json.loads(request.body)
        granted, detail = ActiveLeaseService.claim(
            location=node.location,
            node_id=data['node_id'],
            force=data.get('force', False),
        )
        if not granted:
            return JsonResponse({'error': detail}, status=409)
        return JsonResponse(detail)


@method_decorator(csrf_exempt, name='dispatch')
class SyncNodeConfigView(View):
    def get(self, request):
        node, err = get_auth(request)
        if err:
            return err
        node_id = request.GET.get('node_id', '')
        config = NodeConfigService.get(node.location, node_id)
        if config is None:
            return JsonResponse({}, status=204)
        return JsonResponse({'config': config})

    def post(self, request):
        node, err = get_auth(request)
        if err:
            return err
        data = json.loads(request.body)
        NodeConfigService.save(node.location, data['node_id'], data['config'])
        return JsonResponse({'status': 'saved'})


@method_decorator(csrf_exempt, name='dispatch')
class SyncNodeOfflineView(View):
    """POST /api/v1/sync/node-offline/ — the calling node announces it is going
    offline (clean logout / reset), so it is immediately reclaimable."""

    def post(self, request):
        node, err = get_auth(request)
        if err:
            return err
        node.is_online = False
        node.save(update_fields=['is_online', 'updated_at'])
        return JsonResponse({'status': 'offline', 'node_id': node.node_id})


def get_actor_location(request, data=None):
    """Resolve the target location for a write, accepting EITHER a node Api-Key
    OR a manager/owner Bearer session. Returns (location, error_response)."""
    node, err = get_auth(request)
    if not err:
        return node.location, None

    user = get_session_user(request)
    if not user or user.role not in ['manager', 'owner']:
        return None, JsonResponse(
            {'error': 'Api-Key or manager session required'}, status=401
        )

    from core.models import Location
    location_id = (
        (data or {}).get('location_id')
        or request.GET.get('location')
        or request.GET.get('location_id')
    )
    try:
        location = Location.objects.get(pk=location_id)
    except (Location.DoesNotExist, ValueError):
        return None, JsonResponse({'error': 'Location not found'}, status=404)
    if user.restaurant != location.restaurant:
        return None, JsonResponse({'error': 'Location restaurant mismatch'}, status=403)
    return location, None


def get_session_user(request):
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer tok_'):
        return None
    session_key = auth_header[len('Bearer tok_'):]
    from django.contrib.sessions.backends.db import SessionStore
    from core.models import StaffUser
    try:
        session = SessionStore(session_key=session_key)
        user_id = session.get('_auth_user_id')
        if user_id:
            user = StaffUser.objects.select_related('location', 'restaurant').get(pk=user_id)
            if user.is_active:
                return user
    except Exception:
        pass
    return None


def _serialize_location(loc) -> dict:
    """Location summary including geofence config so the app can pre-check clock-in
    range locally. The server still re-validates on clock-in — this is UX only."""
    return {
        'id': str(loc.id),
        'name': loc.name,
        'latitude': loc.latitude,
        'longitude': loc.longitude,
        'geofence_radius_m': loc.geofence_radius_m,
    }


def serialize_user_context(user) -> dict:
    """Shared {user, restaurants[].locations[]} payload for login + /auth/me/."""
    restaurant = user.restaurant
    restaurants = []
    if restaurant:
        if user.location:
            locations = [user.location]
        else:
            locations = list(restaurant.locations.all())
        restaurants.append({
            'id': str(restaurant.id),
            'name': restaurant.name,
            'locations': [_serialize_location(loc) for loc in locations],
        })
    return {
        'user': {
            'name': user.get_full_name() or user.username,
            'username': user.username,
            'email': user.email,
            'role': user.role,
            'location': (
                _serialize_location(user.location) if user.location else None
            ),
        },
        'restaurants': restaurants,
    }


@method_decorator(csrf_exempt, name='dispatch')
class AuthLoginView(View):
    def post(self, request):
        try:
            data = json.loads(request.body)
            email = data.get('email')
            password = data.get('password')
        except Exception:
            return JsonResponse({'error': 'Invalid request body'}, status=400)

        from django.contrib.auth import authenticate, login
        from core.models import StaffUser

        user = StaffUser.objects.filter(email=email).first()
        if not user:
            user = StaffUser.objects.filter(username=email).first()

        if not user:
            return JsonResponse({'error': 'Invalid credentials'}, status=401)

        authenticated_user = authenticate(username=user.username, password=password)
        if authenticated_user is None or not authenticated_user.is_active:
            return JsonResponse({'error': 'Invalid credentials'}, status=401)

        login(request, authenticated_user)
        session_token = request.session.session_key
        if not session_token:
            request.session.create()
            session_token = request.session.session_key

        return JsonResponse({
            'session_token': f'tok_{session_token}',
            # Layer-2 staff "shift" JWT for offline use against Electron devices.
            # Absent only if the user has no restaurant (e.g. a superuser).
            **_staff_token_block(authenticated_user),
            **serialize_user_context(authenticated_user),
        })


def _staff_token_block(user) -> dict:
    """Best-effort staff JWT block for the login/refresh responses."""
    from core.services.staff_token_service import StaffTokenError, mint_staff_token

    try:
        return mint_staff_token(user)
    except StaffTokenError:
        return {}


@method_decorator(csrf_exempt, name='dispatch')
class AuthMeView(View):
    """GET /api/v1/auth/me/ — re-validate a stored token on app relaunch.

    Returns the same {user, restaurants} context as login (without a new token),
    or 401 if the Bearer token is missing/invalid.
    """

    def get(self, request):
        user = get_session_user(request)
        if user is None:
            return JsonResponse({'error': 'Invalid or expired token'}, status=401)
        return JsonResponse(serialize_user_context(user))


@method_decorator(csrf_exempt, name='dispatch')
class AuthLogoutView(View):
    """POST /api/v1/auth/logout/ — invalidate the current Bearer session token."""

    def post(self, request):
        from django.contrib.auth import logout
        from django.contrib.sessions.backends.db import SessionStore

        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer tok_'):
            session_key = auth_header[len('Bearer tok_'):]
            try:
                session = SessionStore(session_key=session_key)
                session.flush()
            except Exception:
                pass
        logout(request)
        return JsonResponse({'ok': True})


@method_decorator(csrf_exempt, name='dispatch')
class AuthStaffTokenView(View):
    """POST /api/v1/auth/staff-token/ — mint a fresh staff shift JWT.

    Used by the mobile client to silently refresh an expired/expiring token when
    internet is available, without re-entering the password. Authenticated by
    the existing manager/staff session Bearer token (tok_…)."""

    def post(self, request):
        user = get_session_user(request)
        if user is None:
            return JsonResponse({'error': 'Invalid or expired session'}, status=401)

        from core.services.staff_token_service import StaffTokenError, mint_staff_token

        try:
            return JsonResponse(mint_staff_token(user))
        except StaffTokenError as exc:
            return JsonResponse({'error': str(exc)}, status=400)


@method_decorator(csrf_exempt, name='dispatch')
class SyncAuthMaterialView(View):
    """GET /api/v1/sync/auth-material/ — a provisioned node fetches the shared
    staff-token verification material for its restaurant.

    Authenticated by the node's own Api-Key. Lets an already-paired device pick
    up the secret (or a rotated one) without re-running the Setup Wizard."""

    def get(self, request):
        node, err = get_auth(request)
        if err:
            return err
        restaurant = node.location.restaurant
        if not restaurant.jwt_signing_secret:
            restaurant.rotate_jwt_secret()
        return JsonResponse({
            'restaurant_id': str(restaurant.id),
            'jwt_secret': restaurant.jwt_signing_secret,
        })


@method_decorator(csrf_exempt, name='dispatch')
class SyncNodesCreateView(View):
    """POST /api/v1/sync/nodes/create/ — manager creates an offline follower node record."""

    def post(self, request):
        try:
            data = json.loads(request.body)
            node_name = data.get('node_name', '').strip()
        except Exception:
            return JsonResponse({'error': 'Invalid request body'}, status=400)

        if not node_name:
            return JsonResponse({'error': 'node_name is required'}, status=400)

        location, err = get_actor_location(request, data)
        if err:
            return err

        from core.models import LocationNode
        import uuid

        node = LocationNode.objects.create(
            location=location,
            node_id=f"node-{uuid.uuid4().hex[:16]}",
            node_label=node_name,
            cluster_role='follower',
            is_online=False,
            api_key_hash='',
        )

        return JsonResponse({
            'node_id': node.node_id,
            'node_name': node.node_label,
            'cluster_role': node.cluster_role,
            'is_online': node.is_online,
        })


@method_decorator(csrf_exempt, name='dispatch')
class AuthReconnectNodeView(View):
    """POST /api/v1/auth/reconnect-node/ — re-issue an API key for an existing node so a
    fresh machine can come online as it."""

    def post(self, request):
        user = get_session_user(request)
        if not user or user.role not in ['manager', 'owner']:
            return JsonResponse({'error': 'Unauthorized manager/owner action'}, status=401)

        try:
            data = json.loads(request.body)
            node_id = data.get('node_id')
        except Exception:
            return JsonResponse({'error': 'Invalid request body'}, status=400)

        if not node_id:
            return JsonResponse({'error': 'node_id is required'}, status=400)

        from core.models import LocationNode
        import secrets
        from core.authentication import hash_api_key

        node = (
            LocationNode.objects.select_related('location__restaurant')
            .filter(node_id=node_id)
            .order_by('-created_at')
            .first()
        )
        if node is None:
            return JsonResponse({'error': 'Node not found'}, status=404)

        if user.restaurant != node.location.restaurant:
            return JsonResponse({'error': 'Node restaurant mismatch'}, status=403)

        # Hash the BARE key; the client strips the sk_live_ prefix before sending
        # it back as `Api-Key <bare>`, matching ApiKeyAuth which hashes the bare value.
        raw_key = secrets.token_hex(32)
        node.api_key_hash = hash_api_key(raw_key)
        node.is_online = True
        node.save(update_fields=['api_key_hash', 'is_online', 'updated_at'])

        restaurant = node.location.restaurant
        if not restaurant.jwt_signing_secret:
            restaurant.rotate_jwt_secret()

        return JsonResponse({
            'node_id': node.node_id,
            'api_key': f'sk_live_{raw_key}',
            'node_name': node.node_label,
            'cluster_role': node.cluster_role,
            'location': {
                'id': str(node.location.id),
                'name': node.location.name,
            },
            # Device auth material (Layer 1 → enables Layer 2 offline verification).
            'restaurant_id': str(restaurant.id),
            'jwt_secret': restaurant.jwt_signing_secret,
        })


def _serialize_attendance(att) -> dict:
    return {
        'clocked_in': att.clock_out_at is None,
        'shift_id': str(att.id),
        'clock_in_at': att.clock_in_at.isoformat(),
        'clock_out_at': att.clock_out_at.isoformat() if att.clock_out_at else None,
    }


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    """Great-circle distance between two WGS-84 points, in metres."""
    import math
    r = 6371000.0  # Earth radius (m)
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _read_coords(request):
    """Pull (lat, lng) floats from a JSON body, or (None, None) if absent/invalid."""
    try:
        data = json.loads(request.body or '{}')
    except (ValueError, TypeError):
        return None, None
    lat, lng = data.get('latitude'), data.get('longitude')
    try:
        return (float(lat), float(lng)) if lat is not None and lng is not None else (None, None)
    except (TypeError, ValueError):
        return None, None


@method_decorator(csrf_exempt, name='dispatch')
class AttendanceStatusView(View):
    """GET /api/v1/attendance/status/ — return the caller's current open shift, or not-clocked-in."""

    def get(self, request):
        user = get_session_user(request)
        if user is None:
            return JsonResponse(
                {'error': {'code': 'UNAUTHORIZED', 'message': 'Login required'}}, status=401
            )
        from core.models import StaffAttendance
        open_shift = StaffAttendance.objects.filter(
            staff_user=user, clock_out_at__isnull=True
        ).first()
        if open_shift is None:
            return JsonResponse({'clocked_in': False, 'shift_id': None, 'clock_in_at': None})
        return JsonResponse(_serialize_attendance(open_shift))


@method_decorator(csrf_exempt, name='dispatch')
class AttendanceClockInView(View):
    """POST /api/v1/attendance/clock-in/ — open a new shift for the authenticated user.

    Body (optional): {latitude, longitude}. When the user's location has a geofence
    configured, coordinates are REQUIRED and must fall within geofence_radius_m of
    the location's centre — this is enforced server-side regardless of any client
    pre-check, so a tampered client cannot bypass it.
    """

    def post(self, request):
        user = get_session_user(request)
        if user is None:
            return JsonResponse(
                {'error': {'code': 'UNAUTHORIZED', 'message': 'Login required'}}, status=401
            )
        from core.models import StaffAttendance
        if StaffAttendance.objects.filter(staff_user=user, clock_out_at__isnull=True).exists():
            return JsonResponse(
                {'error': {'code': 'ALREADY_CLOCKED_IN', 'message': 'Already clocked in'}},
                status=409,
            )

        lat, lng = _read_coords(request)
        loc = user.location
        distance = None
        if loc is not None and loc.geofence_enabled:
            if lat is None or lng is None:
                return JsonResponse(
                    {'error': {
                        'code': 'LOCATION_REQUIRED',
                        'message': 'Location is required to clock in here. Enable location and try again.',
                    }},
                    status=422,
                )
            distance = _haversine_m(lat, lng, loc.latitude, loc.longitude)
            if distance > loc.geofence_radius_m:
                return JsonResponse(
                    {'error': {
                        'code': 'OUTSIDE_GEOFENCE',
                        'message': (
                            f'You are {int(round(distance))} m away. You must be within '
                            f'{loc.geofence_radius_m} m of {loc.name} to clock in.'
                        ),
                        'distance_m': round(distance, 1),
                        'radius_m': loc.geofence_radius_m,
                    }},
                    status=403,
                )

        att = StaffAttendance.objects.create(
            staff_user=user,
            location=loc,
            clock_in_lat=lat,
            clock_in_lng=lng,
            clock_in_distance_m=distance,
        )
        return JsonResponse(_serialize_attendance(att), status=201)


@method_decorator(csrf_exempt, name='dispatch')
class AttendanceClockOutView(View):
    """POST /api/v1/attendance/clock-out/ — close the caller's open shift.

    Body (optional): {latitude, longitude} — recorded for the audit trail. Clock-out
    is never geofenced (staff must always be able to end a shift)."""

    def post(self, request):
        user = get_session_user(request)
        if user is None:
            return JsonResponse(
                {'error': {'code': 'UNAUTHORIZED', 'message': 'Login required'}}, status=401
            )
        from django.utils import timezone
        from core.models import StaffAttendance
        open_shift = StaffAttendance.objects.filter(
            staff_user=user, clock_out_at__isnull=True
        ).first()
        if open_shift is None:
            return JsonResponse(
                {'error': {'code': 'NOT_CLOCKED_IN', 'message': 'Not clocked in'}}, status=409
            )
        lat, lng = _read_coords(request)
        open_shift.clock_out_at = timezone.now()
        open_shift.clock_out_lat = lat
        open_shift.clock_out_lng = lng
        out_distance = None
        loc = open_shift.location
        if lat is not None and lng is not None and loc is not None and loc.geofence_enabled:
            out_distance = _haversine_m(lat, lng, loc.latitude, loc.longitude)
        open_shift.clock_out_distance_m = out_distance
        open_shift.save(update_fields=[
            'clock_out_at', 'clock_out_lat', 'clock_out_lng',
            'clock_out_distance_m', 'updated_at',
        ])
        return JsonResponse(_serialize_attendance(open_shift))


@method_decorator(csrf_exempt, name='dispatch')
class AttendanceHistoryView(View):
    """GET /api/v1/attendance/history/?from=YYYY-MM-DD&to=YYYY-MM-DD

    Returns per-day worked minutes for the authenticated user, aggregated in the
    location's local timezone (defaults to the project TZ). Powers the profile
    heatmap. An open shift counts up to 'now'. Range is clamped to 400 days."""

    def get(self, request):
        user = get_session_user(request)
        if user is None:
            return JsonResponse(
                {'error': {'code': 'UNAUTHORIZED', 'message': 'Login required'}}, status=401
            )

        from datetime import date, datetime, timedelta
        from zoneinfo import ZoneInfo
        from django.conf import settings
        from django.utils import timezone
        from core.models import StaffAttendance

        def parse_day(value, fallback):
            try:
                return datetime.strptime(value, '%Y-%m-%d').date()
            except (TypeError, ValueError):
                return fallback

        today = timezone.localdate()
        start = parse_day(request.GET.get('from'), today.replace(day=1))
        end = parse_day(request.GET.get('to'), today)
        if end < start:
            start, end = end, start
        if (end - start).days > 400:
            start = end - timedelta(days=400)

        tz_name = getattr(getattr(user, 'location', None), 'timezone', None) or settings.TIME_ZONE
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = ZoneInfo(settings.TIME_ZONE)

        # Pull shifts overlapping [start 00:00 local, end 23:59 local].
        range_start = datetime.combine(start, datetime.min.time(), tzinfo=tz)
        range_end = datetime.combine(end + timedelta(days=1), datetime.min.time(), tzinfo=tz)
        now = timezone.now()

        shifts = StaffAttendance.objects.filter(
            staff_user=user, clock_in_at__lt=range_end,
        ).filter(
            models.Q(clock_out_at__isnull=True) | models.Q(clock_out_at__gte=range_start)
        ).values_list('clock_in_at', 'clock_out_at')

        # Aggregate minutes per local calendar day, splitting shifts that cross midnight.
        minutes_by_day: dict[str, float] = {}
        shifts_by_day: dict[str, int] = {}
        for clock_in, clock_out in shifts:
            seg_start = clock_in.astimezone(tz)
            seg_end = (clock_out or now).astimezone(tz)
            if seg_end <= seg_start:
                continue
            day = seg_start.date()
            shifts_by_day[day.isoformat()] = shifts_by_day.get(day.isoformat(), 0) + 1
            cursor = seg_start
            # Walk day-by-day so a shift spanning midnight is credited to each day.
            while cursor < seg_end:
                day_end = datetime.combine(
                    cursor.date() + timedelta(days=1), datetime.min.time(), tzinfo=tz
                )
                chunk_end = min(seg_end, day_end)
                key = cursor.date().isoformat()
                if start <= cursor.date() <= end:
                    minutes_by_day[key] = (
                        minutes_by_day.get(key, 0.0)
                        + (chunk_end - cursor).total_seconds() / 60.0
                    )
                cursor = chunk_end

        days = [
            {
                'date': d,
                'minutes': int(round(minutes_by_day[d])),
                'shifts': shifts_by_day.get(d, 0),
            }
            for d in sorted(minutes_by_day.keys())
        ]
        return JsonResponse({
            'from': start.isoformat(),
            'to': end.isoformat(),
            'days': days,
            'total_minutes': int(round(sum(minutes_by_day.values()))),
            'total_days': len([d for d in days if d['minutes'] > 0]),
        })


@method_decorator(csrf_exempt, name='dispatch')
class SyncNodesView(View):
    def get(self, request):
        node, err = get_auth(request)
        user = None
        if err:
            user = get_session_user(request)
            if not user:
                return err
            location_id = request.GET.get('location_id') or request.GET.get('location')
            from core.models import Location
            try:
                location = Location.objects.get(pk=location_id)
            except (Location.DoesNotExist, ValueError):
                return JsonResponse({'error': 'Location not found'}, status=404)

            if user.restaurant != location.restaurant:
                return JsonResponse({'error': 'Location restaurant mismatch'}, status=403)
        else:
            location = node.location

        from django.utils import timezone
        from core.models import LocationNode

        now = timezone.now()
        nodes_list = []
        for n in LocationNode.objects.filter(location=location):
            # Follower freshness comes from the leader snapshot; leader freshness
            # from its own cloud heartbeat.
            stamp = n.last_heartbeat_at if n.cluster_role == 'leader' else n.cluster_reported_at
            if stamp is None:
                stamp = n.last_heartbeat_at
            last_seen = None
            if stamp:
                last_seen = int((now - stamp).total_seconds())
            nodes_list.append({
                'node_id': n.node_id,
                'node_name': n.node_label,
                'cluster_role': n.cluster_role,
                'is_online': is_node_fresh(n, now),
                'lan_host': n.lan_host,
                'lan_port': n.lan_port,
                'last_seen_seconds': last_seen,
            })

        return JsonResponse({
            'nodes': nodes_list,
            'lease': ActiveLeaseService.status(location)
        })


@method_decorator(csrf_exempt, name='dispatch')
class SyncPrintRoutesView(View):
    """
    GET  /api/v1/sync/print-routes/  — Api-Key (node) OR Bearer session (manager).
         Returns the station catalog, the fixed print types, and current routes.
    POST /api/v1/sync/print-routes/  — Bearer session (manager). Upserts routes.
    """

    def get(self, request):
        location, err = get_actor_location(request)
        if err:
            return err

        from core.models import PrintRoute
        from core.services.print_route_service import (
            ensure_print_routes,
            is_valid_route,
            station_name,
        )
        from menu.models import Kitchen
        from tables.models import Section

        ensure_print_routes(location)

        kitchens = list(
            Kitchen.objects.filter(location=location, is_active=True)
            .order_by('code')
            .values('code', 'name')
        )
        sections = list(
            Section.objects.filter(location=location, is_active=True)
            .order_by('display_order', 'code')
            .values('code', 'name')
        )

        routes = []
        qs = PrintRoute.objects.filter(location=location).select_related('assigned_node')
        for r in qs:
            node = r.assigned_node
            routes.append({
                'station_code': r.station_code,
                'station_name': station_name(location, r.station_code, r.print_type),
                'print_type': r.print_type,
                'assigned_node_id': node.node_id if node else None,
                'assigned_node_name': node.node_label if node else None,
                'node_is_online': is_node_fresh(node) if node else None,
            })

        return JsonResponse({
            'kot_stations': [{'code': k['code'], 'name': k['name']} for k in kitchens],
            'bill_stations': [{'code': s['code'], 'name': s['name']} for s in sections],
            # Legacy union — prefer kot_stations / bill_stations in new clients.
            'stations': [
                {'code': k['code'], 'name': k['name'], 'print_type': 'KOT'} for k in kitchens
            ] + [
                {'code': s['code'], 'name': s['name'], 'print_type': 'BILL'} for s in sections
            ],
            'print_types': [PrintRoute.PrintType.KOT, PrintRoute.PrintType.BILL],
            'routes': routes,
        })

    def post(self, request):
        try:
            data = json.loads(request.body)
            entries = data.get('routes', [])
        except Exception:
            return JsonResponse({'error': 'Invalid request body'}, status=400)

        location, err = get_actor_location(request, data)
        if err:
            return err

        from django.db import transaction
        from core.models import LocationNode, PrintRoute
        from core.services.print_route_service import is_valid_route

        valid_types = {PrintRoute.PrintType.KOT, PrintRoute.PrintType.BILL}
        saved = 0
        skipped = 0
        with transaction.atomic():
            for e in entries:
                station_code = (e.get('station_code') or '').strip().upper()
                print_type = e.get('print_type')
                if not station_code or print_type not in valid_types:
                    skipped += 1
                    continue
                if not is_valid_route(location, station_code, print_type):
                    skipped += 1
                    continue
                assigned_node_id = e.get('assigned_node_id')
                node = None
                if assigned_node_id:
                    node = LocationNode.objects.filter(
                        location=location, node_id=assigned_node_id
                    ).first()
                PrintRoute.objects.update_or_create(
                    location=location,
                    station_code=station_code,
                    print_type=print_type,
                    defaults={'assigned_node': node},
                )
                saved += 1

        return JsonResponse({'saved': saved, 'skipped': skipped})
