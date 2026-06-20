"""Print routing helpers — KOT keyed by Kitchen.code, BILL keyed by Section.code."""

from __future__ import annotations

from core.models import Location, PrintRoute
from menu.models import Kitchen
from tables.models import Section


def kitchen_codes(location: Location) -> set[str]:
    return set(
        Kitchen.objects.filter(location=location, is_active=True).values_list('code', flat=True)
    )


def section_codes(location: Location) -> set[str]:
    return set(
        Section.objects.filter(location=location, is_active=True).values_list('code', flat=True)
    )


def station_name(location: Location, station_code: str, print_type: str) -> str:
    if print_type == PrintRoute.PrintType.KOT:
        row = Kitchen.objects.filter(location=location, code=station_code).values('name').first()
    else:
        row = Section.objects.filter(location=location, code=station_code).values('name').first()
    return row['name'] if row else station_code


def is_valid_route(location: Location, station_code: str, print_type: str) -> bool:
    """KOT must match a Kitchen; BILL must match a Section (never kitchen-only)."""
    code = (station_code or '').strip().upper()
    if not code:
        return False
    if print_type == PrintRoute.PrintType.KOT:
        return code in kitchen_codes(location)
    if print_type == PrintRoute.PrintType.BILL:
        return code in section_codes(location)
    return False


def remove_legacy_kitchen_bill_routes(location: Location) -> int:
    """Delete BILL routes keyed by kitchen codes that are not also section codes."""
    kitchens = kitchen_codes(location)
    sections = section_codes(location)
    orphan = kitchens - sections
    if not orphan:
        return 0
    deleted, _ = PrintRoute.objects.filter(
        location=location,
        print_type=PrintRoute.PrintType.BILL,
        station_code__in=orphan,
    ).delete()
    return deleted


def ensure_print_routes(location: Location) -> int:
    """Create missing KOT/BILL PrintRoute rows; never overwrite assignments."""
    Section.objects.get_or_create(
        location=location,
        code='COUNTER',
        defaults={'name': 'Counter / Takeaway', 'display_order': 99},
    )
    remove_legacy_kitchen_bill_routes(location)
    created = 0
    for kitchen in Kitchen.objects.filter(location=location, is_active=True):
        _, was_created = PrintRoute.objects.get_or_create(
            location=location,
            station_code=kitchen.code,
            print_type=PrintRoute.PrintType.KOT,
            defaults={'assigned_node': None},
        )
        if was_created:
            created += 1
    for section in Section.objects.filter(location=location, is_active=True):
        _, was_created = PrintRoute.objects.get_or_create(
            location=location,
            station_code=section.code,
            print_type=PrintRoute.PrintType.BILL,
            defaults={'assigned_node': None},
        )
        if was_created:
            created += 1
    return created
