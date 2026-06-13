from django.urls import path
from user_app.views import MenuPageView

urlpatterns = [
    path('<uuid:table_uuid>/', MenuPageView.as_view(), name='user-menu'),
]
