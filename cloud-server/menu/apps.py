from django.apps import AppConfig


class MenuConfig(AppConfig):
    name = 'menu'

    def ready(self):
        # Register menu-version bump signals (section/menu/listing changes).
        from . import signals  # noqa: F401
