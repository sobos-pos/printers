from django.urls import path
from waiter_app.views import PosPageView

urlpatterns = [
    path('', PosPageView.as_view(), name='waiter-pos'),
]
