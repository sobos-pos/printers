from django.urls import path

from tables.views import TableListView, TableMenuView

urlpatterns = [
    path('tables/', TableListView.as_view()),
    path('tables/<uuid:table_uuid>/menu/', TableMenuView.as_view()),
]
