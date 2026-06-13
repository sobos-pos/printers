from django.urls import path

from tables.views import TableMenuView

urlpatterns = [
    path('tables/<uuid:table_uuid>/menu/', TableMenuView.as_view()),
]
