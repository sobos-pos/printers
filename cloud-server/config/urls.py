from django.contrib import admin
from django.urls import include, path
from django.conf import settings
from django.conf.urls.static import static

from core.views import (
    HealthCheckView,
    AuthLoginView,
    AuthMeView,
    AuthLogoutView,
    AuthReconnectNodeView,
)

urlpatterns = [
    path('admin/', admin.site.urls),
    path('health/', HealthCheckView.as_view()),
    path('api/v1/auth/login/', AuthLoginView.as_view()),
    path('api/v1/auth/me/', AuthMeView.as_view()),
    path('api/v1/auth/logout/', AuthLogoutView.as_view()),
    path('api/v1/auth/reconnect-node/', AuthReconnectNodeView.as_view()),
    path('api/v1/', include('tables.urls')),
    path('api/v1/', include('orders.urls')),
    path('api/v1/sync/', include('core.urls')),
    path('api/v1/', include('menu.urls')),
    path('order/', include('user_app.urls')),
    path('pos/', include('waiter_app.urls')),
    path('super-admin/', include('super_admin.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
