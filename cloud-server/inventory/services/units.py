"""Unit conversion shared across inventory services."""

from decimal import Decimal


def convert_units(quantity, from_unit, to_unit):
    """Convert ``quantity`` from ``from_unit`` into ``to_unit``.

    Both units must share the same base unit (or one must be the base).
    Raises ``ValueError`` if they are not convertible.
    """
    if from_unit.id == to_unit.id:
        return quantity

    from_base = from_unit.base_unit or from_unit
    to_base = to_unit.base_unit or to_unit

    if (
        from_base.id != to_base.id
        and from_unit.id != to_base.id
        and to_unit.id != from_base.id
    ):
        raise ValueError(
            f'Cannot convert between {from_unit.short_name} and '
            f'{to_unit.short_name} — they have different base units.'
        )

    from_factor = from_unit.conversion_factor if from_unit.base_unit else Decimal('1')
    to_factor = to_unit.conversion_factor if to_unit.base_unit else Decimal('1')

    base_quantity = quantity * from_factor
    return base_quantity / to_factor
