"""Menu-version bumps for the visibility/pricing axis.

The node menu cache is version-gated: it only re-pulls a snapshot when the
location's MenuVersion is newer than what it has. Section/Menu/SectionMenu/
MenuListing edits change what each section sees and what it's priced at, so
they MUST bump the version or nodes would keep serving a stale menu.

Connected to the concrete model classes, so these receivers do NOT fire during
data migrations (which use historical models) — only on real app-level writes
(admin, shell, seed_demo, API).
"""

from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from menu.models import Menu, MenuListing, SectionMenu
from tables.models import Section


def _bump(location) -> None:
    if location is None:
        return
    # Imported lazily to avoid a circular import at app-load time.
    from menu.services.menu_service import MenuService
    MenuService.bump_version(location)


@receiver([post_save, post_delete], sender=Section)
def _section_changed(sender, instance, **kwargs):
    _bump(instance.location)


@receiver([post_save, post_delete], sender=Menu)
def _menu_changed(sender, instance, **kwargs):
    _bump(instance.location)


@receiver([post_save, post_delete], sender=SectionMenu)
def _section_menu_changed(sender, instance, **kwargs):
    # section may already be loaded; .location is one cheap FK hop.
    _bump(instance.section.location)


@receiver([post_save, post_delete], sender=MenuListing)
def _menu_listing_changed(sender, instance, **kwargs):
    _bump(instance.menu.location)
