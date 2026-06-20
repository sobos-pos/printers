from django.urls import path
from super_admin.views import (
    SuperAdminLoginView,
    SuperAdminLogoutView,
    SuperAdminDashboardView,
    BranchCreateView,
    InviteCreateView,
    StaffActivateView,
)

urlpatterns = [
    path('login/', SuperAdminLoginView.as_view(), name='super_admin_login'),
    path('logout/', SuperAdminLogoutView.as_view(), name='super_admin_logout'),
    path('branch/create/', BranchCreateView.as_view(), name='branch_create'),
    path('invite/create/', InviteCreateView.as_view(), name='invite_create'),
    path('activate/<uuid:token>/', StaffActivateView.as_view(), name='staff_activate'),
    path('', SuperAdminDashboardView.as_view(), name='super_admin_dashboard'),
]
