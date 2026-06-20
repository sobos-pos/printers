import datetime
from django.db import IntegrityError
from django.views.generic import TemplateView
from django.views import View
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth import authenticate, login, logout
from django.contrib import messages
from django.utils import timezone
from django.contrib.auth.mixins import LoginRequiredMixin

from core.models import Restaurant, Location, StaffUser
from super_admin.models import StaffInvitation
from orders.models import Order


def _resolve_restaurant(user):
    if user.restaurant:
        return user.restaurant
    if user.is_superuser:
        return Restaurant.objects.first()
    return None


def _get_orders_for_dashboard(restaurant, request):
    if not restaurant:
        return [], {}

    qs = (
        Order.objects.filter(location__restaurant=restaurant)
        .select_related('table', 'location', 'created_by')
        .order_by('-created_at')
    )

    filters = {
        'status': request.GET.get('status', '').strip(),
        'location': request.GET.get('location', '').strip(),
        'waiter': request.GET.get('waiter', '').strip(),
    }

    if filters['status']:
        qs = qs.filter(status=filters['status'])
    if filters['location']:
        qs = qs.filter(location_id=filters['location'])
    if filters['waiter']:
        qs = qs.filter(created_by_id=filters['waiter'])

    return list(qs[:200]), filters


class SuperAdminAccessMixin:
    """Ensures the user is logged in and is an owner or superuser."""
    def dispatch(self, request, *args, **kwargs):
        if not request.user.is_authenticated:
            return redirect('super_admin_login')
        if request.user.role != 'owner' and not request.user.is_superuser:
            messages.error(request, "Access denied. Only owners or super admins can access this page.")
            return redirect('super_admin_login')
        return super().dispatch(request, *args, **kwargs)


class SuperAdminLoginView(View):
    """GET /super-admin/login/ — Displays the sleek super admin login page.
    POST /super-admin/login/ — Processes the login credentials.
    """
    def get(self, request):
        if request.user.is_authenticated and (request.user.role == 'owner' or request.user.is_superuser):
            return redirect('super_admin_dashboard')
        return render(request, 'super_admin/login.html')

    def post(self, request):
        email = request.POST.get('email', '').strip()
        password = request.POST.get('password', '')

        if not email or not password:
            messages.error(request, "Please fill in all fields.")
            return render(request, 'super_admin/login.html')

        # StaffUser authenticate expects username, but we allow login with email or username.
        user = StaffUser.objects.filter(email=email).first()
        if not user:
            user = StaffUser.objects.filter(username=email).first()

        if user:
            authenticated_user = authenticate(request, username=user.username, password=password)
            if authenticated_user:
                login(request, authenticated_user)
                messages.success(request, f"Welcome back, {authenticated_user.username}!")
                return redirect('super_admin_dashboard')

        messages.error(request, "Invalid credentials.")
        return render(request, 'super_admin/login.html')


class SuperAdminLogoutView(View):
    """GET /super-admin/logout/ — Logs out the super admin."""
    def get(self, request):
        logout(request)
        messages.success(request, "Logged out successfully.")
        return redirect('super_admin_login')


class SuperAdminDashboardView(SuperAdminAccessMixin, TemplateView):
    """GET /super-admin/ — Displays the owner/superuser dashboard."""
    template_name = 'super_admin/dashboard.html'

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        user = self.request.user

        restaurant = _resolve_restaurant(user)

        ctx['restaurant'] = restaurant
        if restaurant:
            ctx['locations'] = Location.objects.filter(restaurant=restaurant, is_active=True).order_by('name')
            ctx['staff'] = StaffUser.objects.filter(restaurant=restaurant).select_related('location').order_by('username')
            ctx['invitations'] = StaffInvitation.objects.filter(restaurant=restaurant).select_related('user', 'location').order_by('-created_at')
            ctx['waiters'] = StaffUser.objects.filter(
                restaurant=restaurant,
                role__in=['waiter', 'staff', 'manager'],
            ).order_by('username')
            ctx['orders'], ctx['order_filters'] = _get_orders_for_dashboard(restaurant, self.request)
            ctx['order_statuses'] = [s.value for s in Order.Status]
        else:
            ctx['locations'] = []
            ctx['staff'] = []
            ctx['invitations'] = []
            ctx['waiters'] = []
            ctx['orders'] = []
            ctx['order_filters'] = {}
            ctx['order_statuses'] = []

        return ctx


class BranchCreateView(SuperAdminAccessMixin, View):
    """POST /super-admin/branch/create/ — Handles creation of branches (Locations)."""
    def post(self, request):
        user = request.user
        restaurant = _resolve_restaurant(user)

        if not restaurant:
            messages.error(request, "No restaurant available to add a branch.")
            return redirect('super_admin_dashboard')

        name = request.POST.get('name', '').strip()
        address = request.POST.get('address', '').strip()
        timezone_val = request.POST.get('timezone', 'Asia/Kolkata').strip()

        if not name:
            messages.error(request, "Branch name is required.")
            return redirect('super_admin_dashboard')

        def _parse_float(raw):
            raw = (raw or '').strip()
            try:
                return float(raw) if raw else None
            except ValueError:
                return None

        latitude = _parse_float(request.POST.get('latitude'))
        longitude = _parse_float(request.POST.get('longitude'))
        radius_raw = (request.POST.get('geofence_radius_m') or '').strip()
        try:
            radius = int(radius_raw) if radius_raw else 200
        except ValueError:
            radius = 200

        try:
            Location.objects.create(
                restaurant=restaurant,
                name=name,
                address=address,
                timezone=timezone_val,
                latitude=latitude,
                longitude=longitude,
                geofence_radius_m=radius,
                is_active=True
            )
            messages.success(request, f"Branch '{name}' created successfully.")
        except Exception as e:
            messages.error(request, f"Error creating branch: {e}")

        return redirect('super_admin_dashboard')


class InviteCreateView(SuperAdminAccessMixin, View):
    """POST /super-admin/invite/create/ — Handles creating inactive staff and generating invites."""
    def post(self, request):
        user = request.user
        restaurant = _resolve_restaurant(user)

        if not restaurant:
            messages.error(request, "No restaurant context available.")
            return redirect('super_admin_dashboard')

        username = request.POST.get('username', '').strip()
        email = request.POST.get('email', '').strip()
        role = request.POST.get('role', 'waiter').strip()
        location_id = request.POST.get('location_id', '').strip()
        password = request.POST.get('password', '')

        if not username or not email or not location_id or not password:
            messages.error(request, "Please fill in all staff registration fields.")
            return redirect('super_admin_dashboard')

        # Validate location
        location = get_object_or_404(Location, id=location_id, restaurant=restaurant)

        # Check existing username / email
        if StaffUser.objects.filter(username=username).exists():
            messages.error(request, f"Username '{username}' is already taken.")
            return redirect('super_admin_dashboard')

        if StaffUser.objects.filter(email=email).exists():
            messages.error(request, f"Email '{email}' is already registered.")
            return redirect('super_admin_dashboard')

        try:
            # Create inactive user credentials
            staff_user = StaffUser.objects.create_user(
                username=username,
                email=email,
                password=password,
                restaurant=restaurant,
                location=location,
                role=role,
                is_active=False
            )

            # Create invitation link (valid for 7 days)
            expires_at = timezone.now() + datetime.timedelta(days=7)
            invitation = StaffInvitation.objects.create(
                restaurant=restaurant,
                location=location,
                user=staff_user,
                expires_at=expires_at,
                created_by=user
            )

            invite_url = request.build_absolute_uri(f"/super-admin/activate/{invitation.token}/")
            messages.success(request, f"Staff '{username}' credentials created. Activation link: {invite_url}")

        except Exception as e:
            messages.error(request, f"Error creating staff invitation: {e}")

        return redirect('super_admin_dashboard')


class StaffActivateView(View):
    """GET /super-admin/activate/<uuid:token>/ — Displays password verification / login page.
    POST /super-admin/activate/<uuid:token>/ — Activates status on password match.
    """
    def get(self, request, token):
        invitation = get_object_or_404(StaffInvitation, token=token)

        if invitation.is_accepted:
            messages.info(request, "This invitation has already been accepted.")
            return redirect('super_admin_login')

        if invitation.is_expired():
            messages.error(request, "This invitation link has expired. Please request a new one.")
            return redirect('super_admin_login')

        ctx = {
            'invitation': invitation,
            'username': invitation.user.username,
            'email': invitation.user.email,
            'branch': invitation.location.name,
            'role': invitation.user.get_role_display() if hasattr(invitation.user, 'get_role_display') else invitation.user.role,
        }
        return render(request, 'super_admin/activate.html', ctx)

    def post(self, request, token):
        invitation = get_object_or_404(StaffInvitation, token=token)

        if invitation.is_accepted or invitation.is_expired():
            messages.error(request, "Invalid or expired invitation.")
            return redirect('super_admin_login')

        password = request.POST.get('password', '')
        user = invitation.user

        # Authenticate inactive user credentials
        # Django authenticate() normally allows inactive users if configured or we can check manually.
        # To avoid issues with default backend rejecting inactive users, we check the password first:
        if user.check_password(password):
            # Activate user
            user.is_active = True
            user.save()

            # Mark invite as accepted
            invitation.is_accepted = True
            invitation.save()

            # Authenticate and login
            # We fetch user via authenticate after activation (since is_active=True now)
            auth_user = authenticate(request, username=user.username, password=password)
            if auth_user:
                login(request, auth_user)

            messages.success(request, f"Your account '{user.username}' is now active and verified!")
            # Redirect to the POS view (waiter_app)
            return redirect('/pos/')
        else:
            messages.error(request, "Invalid password.")
            return self.get(request, token)
