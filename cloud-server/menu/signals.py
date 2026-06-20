"""Menu-version bumps for the visibility/pricing axis.

The node menu cache is version-gated: it only re-pulls a snapshot when the
location's MenuVersion is newer than what it has. Section/Menu/SectionMenu/
MenuListing(+VariantPrice) edits change what each section sees and what it's
priced at, so they MUST bump the version or nodes would keep serving a stale
menu. Glossary edits (tax rates / charges) feed the priced bill, so they bump
too — but glossary is global, so they invalidate every synced location.

Connected to the concrete model classes, so these receivers do NOT fire during
data migrations (which use historical models) — only on real app-level writes
(admin, shell, seed_demo, API).
"""

from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from menu.models import (
    Charge,
    Menu,
    MenuListing,
    MenuListingVariantPrice,
    SectionMenu,
    Tax,
    TaxGroup,
    TaxGroupTax,
)
from tables.models import Section


def _bump(location) -> None:
    if location is None:
        return
    # Imported lazily to avoid a circular import at app-load time.
    from menu.services.menu_service import MenuService
    MenuService.bump_version(location)


def _bump_all_synced_locations() -> None:
    """Bump every location that has already synced a menu.

    Glossary tables (Tax/TaxGroup/Charge) are global, so a rate change can
    affect any location that prices against them. Locations with no MenuVersion
    row yet bootstrap fresh on first pull, so they need no invalidation.
    """
    from core.models import Location
    for location in Location.objects.filter(menu_version__isnull=False):
        _bump(location)


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


@receiver([post_save, post_delete], sender=MenuListingVariantPrice)
def _listing_variant_price_changed(sender, instance, **kwargs):
    # On cascade delete the parent listing/menu is deleted AFTER its children
    # (FK order), so .menu_listing.menu.location is still resolvable here.
    _bump(instance.menu_listing.menu.location)


@receiver([post_save, post_delete], sender=Tax)
@receiver([post_save, post_delete], sender=TaxGroup)
@receiver([post_save, post_delete], sender=TaxGroupTax)
@receiver([post_save, post_delete], sender=Charge)
def _glossary_changed(sender, instance, **kwargs):
    _bump_all_synced_locations()
