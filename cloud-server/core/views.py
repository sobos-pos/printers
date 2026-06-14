import json
import logging

from django.db import connection
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
        order = SyncService.apply_status_push(
            order_uuid=str(order_uuid),
            new_status=data['status'],
            occurred_at=data.get('occurred_at'),
            idempotency_key=request.headers.get('Idempotency-Key', ''),
        )
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
            return StaffUser.objects.get(pk=user_id)
    except Exception:
        pass
    return None


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
        if authenticated_user is None:
            return JsonResponse({'error': 'Invalid credentials'}, status=401)

        login(request, authenticated_user)
        session_token = request.session.session_key
        if not session_token:
            request.session.create()
            session_token = request.session.session_key

        restaurant = authenticated_user.restaurant
        restaurants = []
        if restaurant:
            restaurants.append({
                'id': str(restaurant.id),
                'name': restaurant.name,
                'locations': [
                    {'id': str(loc.id), 'name': loc.name}
                    for loc in restaurant.locations.all()
                ]
            })

        return JsonResponse({
            'session_token': f'tok_{session_token}',
            'user': {
                'name': authenticated_user.get_full_name() or authenticated_user.username,
                'role': authenticated_user.role,
            },
            'restaurants': restaurants,
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
            node_id=f"node-{uuid.uuid4().hex[:8]}",
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

        try:
            node = LocationNode.objects.select_related('location__restaurant').get(node_id=node_id)
        except LocationNode.DoesNotExist:
            return JsonResponse({'error': 'Node not found'}, status=404)

        if user.restaurant != node.location.restaurant:
            return JsonResponse({'error': 'Node restaurant mismatch'}, status=403)

        # Hash the BARE key; the client strips the sk_live_ prefix before sending
        # it back as `Api-Key <bare>`, matching ApiKeyAuth which hashes the bare value.
        raw_key = secrets.token_hex(32)
        node.api_key_hash = hash_api_key(raw_key)
        node.is_online = True
        node.save(update_fields=['api_key_hash', 'is_online', 'updated_at'])

        return JsonResponse({
            'node_id': node.node_id,
            'api_key': f'sk_live_{raw_key}',
            'node_name': node.node_label,
            'cluster_role': node.cluster_role,
            'location': {
                'id': str(node.location.id),
                'name': node.location.name,
            },
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

        nodes_list = []
        for n in LocationNode.objects.filter(location=location):
            last_seen = None
            if n.last_heartbeat_at:
                last_seen = int((timezone.now() - n.last_heartbeat_at).total_seconds())
            nodes_list.append({
                'node_id': n.node_id,
                'node_name': n.node_label,
                'cluster_role': n.cluster_role,
                'is_online': n.is_online,
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
        from menu.models import PrinterStation

        stations = list(PrinterStation.objects.filter(location=location).values('code', 'name'))
        station_names = {s['code']: s['name'] for s in stations}

        routes = []
        qs = PrintRoute.objects.filter(location=location).select_related('assigned_node')
        for r in qs:
            node = r.assigned_node
            routes.append({
                'station_code': r.station_code,
                'station_name': station_names.get(r.station_code, r.station_code),
                'print_type': r.print_type,
                'assigned_node_id': node.node_id if node else None,
                'assigned_node_name': node.node_label if node else None,
                'node_is_online': node.is_online if node else None,
            })

        return JsonResponse({
            'stations': [{'code': s['code'], 'name': s['name']} for s in stations],
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

        valid_types = {PrintRoute.PrintType.KOT, PrintRoute.PrintType.BILL}
        saved = 0
        with transaction.atomic():
            for e in entries:
                station_code = (e.get('station_code') or '').strip()
                print_type = e.get('print_type')
                if not station_code or print_type not in valid_types:
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

        return JsonResponse({'saved': saved})
