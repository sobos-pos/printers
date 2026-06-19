from django.urls import path

from menu.views import (
    MenuCategoriesView,
    MenuGlossaryView,
    MenuItemDetailView,
    MenuItemMediaView,
    MenuItemsView,
    MenuMediaDetailView,
    MenuTreeView,
)

urlpatterns = [
    path('menu/glossary/', MenuGlossaryView.as_view()),
    path('menu/tree/', MenuTreeView.as_view()),
    path('menu/categories/', MenuCategoriesView.as_view()),
    path('menu/items/', MenuItemsView.as_view()),
    path('menu/items/<uuid:item_id>/', MenuItemDetailView.as_view()),
    path('menu/items/<uuid:item_id>/media/', MenuItemMediaView.as_view()),
    path('menu/media/<uuid:media_id>/', MenuMediaDetailView.as_view()),
]
