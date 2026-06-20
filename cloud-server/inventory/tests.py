"""
Comprehensive tests for the inventory app.

Covers: models, constraints, stock service (adjust, deduct, replenish),
purchase order lifecycle, wastage logging, inter-location transfers,
recipe cost calculation, order deduction, and availability checks.
"""

from decimal import Decimal
from datetime import date, timedelta

from django.test import TestCase
from django.core.exceptions import ValidationError
from django.db import IntegrityError

from core.models import Restaurant, Location
from menu.models import MenuCategory, MenuItem, Variant, Kitchen

from inventory.models import (
    AdjustmentReason,
    Batch,
    BatchStatus,
    CostMethod,
    Ingredient,
    IngredientCategory,
    InventoryUnit,
    MovementType,
    POStatus,
    PurchaseOrder,
    PurchaseOrderItem,
    Recipe,
    RecipeIngredient,
    StockLevel,
    StockMovement,
    StockTransfer,
    TransferStatus,
    WastageLog,
    WastageReason,
)
from inventory.services import (
    purchase_order_service,
    recipe_service,
    stock_service,
    transfer_service,
    wastage_service,
)


class InventoryTestBase(TestCase):
    """Shared setup for all inventory tests."""

    def setUp(self):
        self.restaurant = Restaurant.objects.create(name='Test Restaurant')
        self.location = Location.objects.create(
            restaurant=self.restaurant, name='Main Branch',
        )
        self.location2 = Location.objects.create(
            restaurant=self.restaurant, name='Second Branch',
        )

        # Units
        self.unit_g = InventoryUnit.objects.create(
            name='Gram', short_name='g', restaurant=self.restaurant,
        )
        self.unit_kg = InventoryUnit.objects.create(
            name='Kilogram', short_name='kg',
            base_unit=self.unit_g,
            conversion_factor=Decimal('1000'),
            restaurant=self.restaurant,
        )
        self.unit_ml = InventoryUnit.objects.create(
            name='Millilitre', short_name='ml', restaurant=self.restaurant,
        )
        self.unit_l = InventoryUnit.objects.create(
            name='Litre', short_name='L',
            base_unit=self.unit_ml,
            conversion_factor=Decimal('1000'),
            restaurant=self.restaurant,
        )
        self.unit_piece = InventoryUnit.objects.create(
            name='Piece', short_name='pc', restaurant=self.restaurant,
        )

        # Categories
        self.cat_produce = IngredientCategory.objects.create(
            name='Produce', restaurant=self.restaurant,
        )
        self.cat_dairy = IngredientCategory.objects.create(
            name='Dairy', restaurant=self.restaurant,
        )

        # Ingredients
        self.onion = Ingredient.objects.create(
            name='Onion', unit=self.unit_kg,
            category=self.cat_produce, restaurant=self.restaurant,
        )
        self.tomato = Ingredient.objects.create(
            name='Tomato', unit=self.unit_kg,
            category=self.cat_produce, restaurant=self.restaurant,
        )
        self.paneer = Ingredient.objects.create(
            name='Paneer', unit=self.unit_kg,
            category=self.cat_dairy, restaurant=self.restaurant,
        )
        self.oil = Ingredient.objects.create(
            name='Cooking Oil', unit=self.unit_l,
            restaurant=self.restaurant,
        )


# ===========================================================================
# Model tests
# ===========================================================================

class InventoryUnitModelTests(InventoryTestBase):

    def test_str(self):
        self.assertEqual(str(self.unit_kg), 'kg (Kilogram)')

    def test_unique_constraint(self):
        with self.assertRaises(IntegrityError):
            InventoryUnit.objects.create(
                name='Kilogram Dupe', short_name='kg',
                restaurant=self.restaurant,
            )

    def test_self_reference_validation(self):
        unit = InventoryUnit.objects.create(
            name='Test', short_name='t', restaurant=self.restaurant,
        )
        unit.base_unit = unit
        with self.assertRaises(ValidationError):
            unit.clean()


class IngredientModelTests(InventoryTestBase):

    def test_str(self):
        self.assertEqual(str(self.onion), 'Onion (kg)')

    def test_unique_constraint(self):
        with self.assertRaises(IntegrityError):
            Ingredient.objects.create(
                name='Onion', unit=self.unit_kg,
                restaurant=self.restaurant,
            )


class StockLevelModelTests(InventoryTestBase):

    def test_is_low_stock(self):
        stock = StockLevel.objects.create(
            ingredient=self.onion, location=self.location,
            quantity=Decimal('2'), low_stock_threshold=Decimal('5'),
        )
        self.assertTrue(stock.is_low_stock)

    def test_is_not_low_stock_when_no_threshold(self):
        stock = StockLevel.objects.create(
            ingredient=self.onion, location=self.location,
            quantity=Decimal('2'),
        )
        self.assertFalse(stock.is_low_stock)

    def test_stock_value(self):
        stock = StockLevel.objects.create(
            ingredient=self.onion, location=self.location,
            quantity=Decimal('10'), unit_cost=Decimal('50'),
        )
        self.assertEqual(stock.stock_value, Decimal('500'))

    def test_unique_constraint(self):
        StockLevel.objects.create(
            ingredient=self.onion, location=self.location,
        )
        with self.assertRaises(IntegrityError):
            StockLevel.objects.create(
                ingredient=self.onion, location=self.location,
            )


class BatchModelTests(InventoryTestBase):

    def test_expiry_before_manufacture_validation(self):
        batch = Batch(
            ingredient=self.onion, location=self.location,
            batch_number='B-001',
            manufacture_date=date(2025, 6, 1),
            expiry_date=date(2025, 5, 1),
            received_quantity=Decimal('10'),
            remaining_quantity=Decimal('10'),
        )
        with self.assertRaises(ValidationError):
            batch.clean()

    def test_remaining_exceeds_received_validation(self):
        batch = Batch(
            ingredient=self.onion, location=self.location,
            batch_number='B-002',
            received_quantity=Decimal('10'),
            remaining_quantity=Decimal('15'),
        )
        with self.assertRaises(ValidationError):
            batch.clean()


class StockTransferModelTests(InventoryTestBase):

    def test_same_location_validation(self):
        transfer = StockTransfer(
            transfer_number='TRF-TEST',
            from_location=self.location,
            to_location=self.location,
        )
        with self.assertRaises(ValidationError):
            transfer.clean()


# ===========================================================================
# Stock service tests
# ===========================================================================

class StockServiceTests(InventoryTestBase):

    def test_record_opening_stock(self):
        stock = stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('50'),
            unit_cost=Decimal('40'),
        )
        self.assertEqual(stock.quantity, Decimal('50'))
        self.assertEqual(stock.unit_cost, Decimal('40'))

        # Verify movement
        movement = StockMovement.objects.get(
            ingredient=self.onion, location=self.location,
        )
        self.assertEqual(movement.movement_type, MovementType.OPENING_STOCK)
        self.assertEqual(movement.quantity, Decimal('50'))

    def test_opening_stock_prevents_overwrite(self):
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('50'),
        )
        with self.assertRaises(ValueError):
            stock_service.record_opening_stock(
                ingredient_id=self.onion.id,
                location_id=self.location.id,
                quantity=Decimal('100'),
            )

    def test_adjust_stock(self):
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('50'),
        )
        stock, movement = stock_service.adjust_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            new_quantity=Decimal('45'),
            reason=AdjustmentReason.PHYSICAL_COUNT,
            notes='Physical count correction',
        )
        self.assertEqual(stock.quantity, Decimal('45'))
        self.assertEqual(movement.quantity, Decimal('-5'))
        self.assertEqual(movement.quantity_before, Decimal('50'))
        self.assertEqual(movement.quantity_after, Decimal('45'))

    def test_deduct_stock(self):
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('50'),
        )
        stock, movement = stock_service.deduct_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('10'),
            movement_type=MovementType.ORDER_DEDUCTION,
        )
        self.assertEqual(stock.quantity, Decimal('40'))
        self.assertEqual(movement.quantity, Decimal('-10'))

    def test_deduct_insufficient_stock_raises(self):
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('5'),
        )
        with self.assertRaises(ValueError) as ctx:
            stock_service.deduct_stock(
                ingredient_id=self.onion.id,
                location_id=self.location.id,
                quantity=Decimal('10'),
                movement_type=MovementType.ORDER_DEDUCTION,
            )
        self.assertIn('Insufficient stock', str(ctx.exception))

    def test_replenish_stock_weighted_average(self):
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('10'),
            unit_cost=Decimal('40'),
        )
        stock, movement = stock_service.replenish_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('10'),
            unit_cost=Decimal('60'),
            movement_type=MovementType.PURCHASE_RECEIPT,
        )
        self.assertEqual(stock.quantity, Decimal('20'))
        # Weighted avg: (10*40 + 10*60) / 20 = 1000/20 = 50
        self.assertEqual(stock.unit_cost, Decimal('50'))

    def test_replenish_stock_latest_price(self):
        stock = stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('10'),
            unit_cost=Decimal('40'),
        )
        stock.cost_method = CostMethod.LATEST_PRICE
        stock.save()

        stock, _ = stock_service.replenish_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('10'),
            unit_cost=Decimal('60'),
            movement_type=MovementType.PURCHASE_RECEIPT,
        )
        self.assertEqual(stock.unit_cost, Decimal('60'))

    def test_get_low_stock_items(self):
        StockLevel.objects.create(
            ingredient=self.onion, location=self.location,
            quantity=Decimal('3'), low_stock_threshold=Decimal('5'),
        )
        StockLevel.objects.create(
            ingredient=self.tomato, location=self.location,
            quantity=Decimal('20'), low_stock_threshold=Decimal('5'),
        )
        low = stock_service.get_low_stock_items(self.location.id)
        self.assertEqual(low.count(), 1)
        self.assertEqual(low.first().ingredient, self.onion)


# ===========================================================================
# Purchase order tests
# ===========================================================================

class PurchaseOrderServiceTests(InventoryTestBase):

    def setUp(self):
        super().setUp()
        from inventory.models import Supplier
        self.supplier = Supplier.objects.create(
            name='Fresh Farms', restaurant=self.restaurant,
        )
        # Seed stock so deduction tests have something
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('0'),
            unit_cost=Decimal('0'),
        )

    def test_create_and_submit_po(self):
        po = purchase_order_service.create_purchase_order(
            supplier_id=self.supplier.id,
            location_id=self.location.id,
            order_date=date.today(),
            items_data=[
                {'ingredient_id': self.onion.id, 'ordered_quantity': Decimal('20'), 'unit_price': Decimal('40')},
                {'ingredient_id': self.tomato.id, 'ordered_quantity': Decimal('15'), 'unit_price': Decimal('30')},
            ],
        )
        self.assertEqual(po.status, POStatus.DRAFT)
        self.assertEqual(po.items.count(), 2)
        self.assertTrue(po.po_number.startswith('PO-'))
        self.assertEqual(po.total_amount, Decimal('1250'))  # 20*40 + 15*30

        po = purchase_order_service.submit_purchase_order(po.id)
        self.assertEqual(po.status, POStatus.SUBMITTED)

    def test_receive_po_item_updates_stock(self):
        po = purchase_order_service.create_purchase_order(
            supplier_id=self.supplier.id,
            location_id=self.location.id,
            order_date=date.today(),
            items_data=[
                {'ingredient_id': self.onion.id, 'ordered_quantity': Decimal('20'), 'unit_price': Decimal('40')},
            ],
        )
        purchase_order_service.submit_purchase_order(po.id)

        po_item = po.items.first()
        po_item_result, batch = purchase_order_service.receive_po_item(
            po_item_id=po_item.id,
            received_quantity=Decimal('20'),
            received_unit_price=Decimal('42'),
            batch_number='BATCH-001',
            expiry_date=date.today() + timedelta(days=30),
        )

        # Check stock updated
        stock = StockLevel.objects.get(ingredient=self.onion, location=self.location)
        self.assertEqual(stock.quantity, Decimal('20'))
        self.assertEqual(stock.unit_cost, Decimal('42'))

        # Check batch created
        self.assertIsNotNone(batch)
        self.assertEqual(batch.batch_number, 'BATCH-001')
        self.assertEqual(batch.remaining_quantity, Decimal('20'))

        # Check PO status
        po.refresh_from_db()
        self.assertEqual(po.status, POStatus.FULLY_RECEIVED)

    def test_partial_receipt(self):
        po = purchase_order_service.create_purchase_order(
            supplier_id=self.supplier.id,
            location_id=self.location.id,
            order_date=date.today(),
            items_data=[
                {'ingredient_id': self.onion.id, 'ordered_quantity': Decimal('20'), 'unit_price': Decimal('40')},
            ],
        )
        purchase_order_service.submit_purchase_order(po.id)

        po_item = po.items.first()
        purchase_order_service.receive_po_item(
            po_item_id=po_item.id,
            received_quantity=Decimal('10'),
        )

        po.refresh_from_db()
        self.assertEqual(po.status, POStatus.PARTIALLY_RECEIVED)

        po_item.refresh_from_db()
        self.assertEqual(po_item.pending_quantity, Decimal('10'))

    def test_cancel_po(self):
        po = purchase_order_service.create_purchase_order(
            supplier_id=self.supplier.id,
            location_id=self.location.id,
            order_date=date.today(),
            items_data=[
                {'ingredient_id': self.onion.id, 'ordered_quantity': Decimal('20'), 'unit_price': Decimal('40')},
            ],
        )
        po = purchase_order_service.cancel_purchase_order(po.id)
        self.assertEqual(po.status, POStatus.CANCELLED)

    def test_cannot_cancel_received_po(self):
        po = purchase_order_service.create_purchase_order(
            supplier_id=self.supplier.id,
            location_id=self.location.id,
            order_date=date.today(),
            items_data=[
                {'ingredient_id': self.onion.id, 'ordered_quantity': Decimal('20'), 'unit_price': Decimal('40')},
            ],
        )
        purchase_order_service.submit_purchase_order(po.id)
        purchase_order_service.receive_po_item(
            po_item_id=po.items.first().id,
            received_quantity=Decimal('5'),
        )
        with self.assertRaises(ValueError):
            purchase_order_service.cancel_purchase_order(po.id)


# ===========================================================================
# Wastage tests
# ===========================================================================

class WastageServiceTests(InventoryTestBase):

    def setUp(self):
        super().setUp()
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('50'),
            unit_cost=Decimal('40'),
        )

    def test_log_wastage_deducts_stock(self):
        wastage = wastage_service.log_wastage(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('5'),
            reason=WastageReason.SPOILED,
            notes='Found spoiled in storage',
        )
        self.assertEqual(wastage.quantity, Decimal('5'))
        self.assertEqual(wastage.estimated_cost, Decimal('200'))  # 5 * 40
        self.assertEqual(wastage.reason, WastageReason.SPOILED)

        stock = StockLevel.objects.get(ingredient=self.onion, location=self.location)
        self.assertEqual(stock.quantity, Decimal('45'))

    def test_wastage_summary(self):
        wastage_service.log_wastage(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('5'),
            reason=WastageReason.SPOILED,
        )
        wastage_service.log_wastage(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('3'),
            reason=WastageReason.EXPIRED,
        )

        summary = wastage_service.get_wastage_summary(location_id=self.location.id)
        self.assertEqual(summary['total_quantity'], Decimal('8'))
        self.assertEqual(summary['count'], 2)
        self.assertEqual(len(summary['by_reason']), 2)


# ===========================================================================
# Transfer tests
# ===========================================================================

class TransferServiceTests(InventoryTestBase):

    def setUp(self):
        super().setUp()
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('50'),
            unit_cost=Decimal('40'),
        )
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location2.id,
            quantity=Decimal('10'),
            unit_cost=Decimal('40'),
        )

    def test_full_transfer_workflow(self):
        # 1. Request
        transfer = transfer_service.create_transfer(
            from_location_id=self.location.id,
            to_location_id=self.location2.id,
            items_data=[
                {'ingredient_id': self.onion.id, 'requested_quantity': Decimal('15')},
            ],
            reason='Branch 2 running low',
        )
        self.assertEqual(transfer.status, TransferStatus.REQUESTED)

        # 2. Approve (deducts from sender)
        transfer = transfer_service.approve_transfer(transfer.id)
        self.assertEqual(transfer.status, TransferStatus.APPROVED)

        sender_stock = StockLevel.objects.get(
            ingredient=self.onion, location=self.location,
        )
        self.assertEqual(sender_stock.quantity, Decimal('35'))

        # 3. Dispatch
        transfer = transfer_service.dispatch_transfer(transfer.id)
        self.assertEqual(transfer.status, TransferStatus.DISPATCHED)

        # 4. Receive (adds to receiver)
        transfer = transfer_service.receive_transfer(transfer.id)
        self.assertEqual(transfer.status, TransferStatus.RECEIVED)

        receiver_stock = StockLevel.objects.get(
            ingredient=self.onion, location=self.location2,
        )
        self.assertEqual(receiver_stock.quantity, Decimal('25'))

    def test_reject_transfer(self):
        transfer = transfer_service.create_transfer(
            from_location_id=self.location.id,
            to_location_id=self.location2.id,
            items_data=[
                {'ingredient_id': self.onion.id, 'requested_quantity': Decimal('15')},
            ],
        )
        transfer = transfer_service.reject_transfer(
            transfer.id, rejection_reason='Insufficient stock at sender',
        )
        self.assertEqual(transfer.status, TransferStatus.REJECTED)

        # Stock unchanged
        stock = StockLevel.objects.get(ingredient=self.onion, location=self.location)
        self.assertEqual(stock.quantity, Decimal('50'))

    def test_cannot_transfer_same_location(self):
        with self.assertRaises(ValueError):
            transfer_service.create_transfer(
                from_location_id=self.location.id,
                to_location_id=self.location.id,
                items_data=[
                    {'ingredient_id': self.onion.id, 'requested_quantity': Decimal('5')},
                ],
            )

    def test_invalid_transition_raises(self):
        transfer = transfer_service.create_transfer(
            from_location_id=self.location.id,
            to_location_id=self.location2.id,
            items_data=[
                {'ingredient_id': self.onion.id, 'requested_quantity': Decimal('5')},
            ],
        )
        transfer = transfer_service.reject_transfer(transfer.id)
        with self.assertRaises(ValueError):
            transfer_service.approve_transfer(transfer.id)


# ===========================================================================
# Recipe & order deduction tests
# ===========================================================================

class RecipeServiceTests(InventoryTestBase):

    def setUp(self):
        super().setUp()
        # Menu structure
        self.kitchen = Kitchen.objects.create(
            location=self.location, name='Main Kitchen', code='KITCHEN',
        )
        self.category = MenuCategory.objects.create(
            location=self.location, name='Main Course',
            kitchen=self.kitchen,
        )
        self.menu_item = MenuItem.objects.create(
            category=self.category, name='Paneer Tikka',
        )
        self.variant_half = Variant.objects.create(
            menu_item=self.menu_item, name='Half', price=Decimal('150'),
        )
        self.variant_full = Variant.objects.create(
            menu_item=self.menu_item, name='Full', price=Decimal('250'),
        )

        # Recipe: Paneer Tikka (item-level, per serving)
        self.recipe = Recipe.objects.create(menu_item=self.menu_item)
        RecipeIngredient.objects.create(
            recipe=self.recipe, ingredient=self.paneer,
            quantity=Decimal('0.200'), unit=self.unit_kg,  # 200g
        )
        RecipeIngredient.objects.create(
            recipe=self.recipe, ingredient=self.onion,
            quantity=Decimal('0.100'), unit=self.unit_kg,  # 100g
        )
        RecipeIngredient.objects.create(
            recipe=self.recipe, ingredient=self.oil,
            quantity=Decimal('50'), unit=self.unit_ml,  # 50ml
        )

        # Stock
        stock_service.record_opening_stock(
            ingredient_id=self.paneer.id,
            location_id=self.location.id,
            quantity=Decimal('5'),
            unit_cost=Decimal('320'),
        )
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('10'),
            unit_cost=Decimal('40'),
        )
        stock_service.record_opening_stock(
            ingredient_id=self.oil.id,
            location_id=self.location.id,
            quantity=Decimal('5'),
            unit_cost=Decimal('150'),
        )

    def test_calculate_recipe_cost(self):
        cost = recipe_service.calculate_recipe_cost(
            self.recipe.id, self.location.id,
        )
        # Paneer: 0.2 kg × 320/kg = 64
        # Onion: 0.1 kg × 40/kg = 4
        # Oil: 50 ml → 0.05 L × 150/L = 7.5
        self.assertEqual(cost['total_cost'], Decimal('75.5'))
        self.assertEqual(len(cost['ingredient_costs']), 3)

    def test_check_availability_sufficient(self):
        result = recipe_service.check_ingredient_availability(
            menu_item_id=self.menu_item.id,
            location_id=self.location.id,
            quantity=1,
        )
        self.assertTrue(result['available'])
        self.assertEqual(len(result['shortages']), 0)

    def test_check_availability_insufficient(self):
        result = recipe_service.check_ingredient_availability(
            menu_item_id=self.menu_item.id,
            location_id=self.location.id,
            quantity=100,  # Way more than available
        )
        self.assertFalse(result['available'])
        self.assertGreater(len(result['shortages']), 0)

    def test_deduct_for_order(self):
        from orders.models import Order, OrderItem

        order = Order.objects.create(
            location=self.location,
            source=Order.OrderSource.STAFF_POS,
            total=Decimal('250'),
        )
        OrderItem.objects.create(
            order=order,
            menu_item=self.menu_item,
            variant=self.variant_full,
            quantity=2,
            unit_price=Decimal('250'),
        )

        recipe_service.deduct_ingredients_for_order(
            order_id=order.id,
            location_id=str(self.location.id),
        )

        # Check deductions: 2 servings
        paneer_stock = StockLevel.objects.get(
            ingredient=self.paneer, location=self.location,
        )
        self.assertEqual(paneer_stock.quantity, Decimal('4.6'))  # 5 - (0.2 × 2)

        onion_stock = StockLevel.objects.get(
            ingredient=self.onion, location=self.location,
        )
        self.assertEqual(onion_stock.quantity, Decimal('9.8'))  # 10 - (0.1 × 2)

        # Oil: 50ml = 0.05L per serving, 2 servings = 0.1L
        oil_stock = StockLevel.objects.get(
            ingredient=self.oil, location=self.location,
        )
        self.assertEqual(oil_stock.quantity, Decimal('4.9'))  # 5 - 0.1

    def test_deduct_insufficient_stock_is_atomic(self):
        """If any ingredient is short, nothing should be deducted."""
        from orders.models import Order, OrderItem

        order = Order.objects.create(
            location=self.location,
            source=Order.OrderSource.STAFF_POS,
            total=Decimal('6250'),
        )
        OrderItem.objects.create(
            order=order,
            menu_item=self.menu_item,
            variant=self.variant_full,
            quantity=50,  # Needs 10kg paneer — we only have 5
            unit_price=Decimal('250'),
        )

        with self.assertRaises(ValueError):
            recipe_service.deduct_ingredients_for_order(
                order_id=order.id,
                location_id=str(self.location.id),
            )

        # Nothing deducted
        paneer_stock = StockLevel.objects.get(
            ingredient=self.paneer, location=self.location,
        )
        self.assertEqual(paneer_stock.quantity, Decimal('5'))


# ===========================================================================
# FIFO batch deduction tests
# ===========================================================================

class FIFOBatchTests(InventoryTestBase):

    def test_fifo_deduction_order(self):
        """Oldest batch should be consumed first."""
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('30'),
        )

        batch1 = Batch.objects.create(
            ingredient=self.onion, location=self.location,
            batch_number='OLD-001',
            received_quantity=Decimal('10'),
            remaining_quantity=Decimal('10'),
            unit_cost=Decimal('35'),
        )
        batch2 = Batch.objects.create(
            ingredient=self.onion, location=self.location,
            batch_number='NEW-002',
            received_quantity=Decimal('20'),
            remaining_quantity=Decimal('20'),
            unit_cost=Decimal('40'),
        )

        stock_service.deduct_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('15'),
            movement_type=MovementType.ORDER_DEDUCTION,
        )

        batch1.refresh_from_db()
        batch2.refresh_from_db()
        self.assertEqual(batch1.remaining_quantity, Decimal('0'))
        self.assertEqual(batch1.status, BatchStatus.CONSUMED)
        self.assertEqual(batch2.remaining_quantity, Decimal('15'))
        self.assertEqual(batch2.status, BatchStatus.ACTIVE)


# ===========================================================================
# Audit trail tests
# ===========================================================================

class AuditTrailTests(InventoryTestBase):

    def test_complete_audit_trail(self):
        """Every stock operation should create a StockMovement."""
        stock_service.record_opening_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('100'),
            unit_cost=Decimal('40'),
        )
        stock_service.deduct_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            quantity=Decimal('10'),
            movement_type=MovementType.ORDER_DEDUCTION,
        )
        stock_service.adjust_stock(
            ingredient_id=self.onion.id,
            location_id=self.location.id,
            new_quantity=Decimal('85'),
            reason=AdjustmentReason.PHYSICAL_COUNT,
        )

        movements = StockMovement.objects.filter(
            ingredient=self.onion, location=self.location,
        ).order_by('created_at')

        self.assertEqual(movements.count(), 3)
        self.assertEqual(movements[0].movement_type, MovementType.OPENING_STOCK)
        self.assertEqual(movements[1].movement_type, MovementType.ORDER_DEDUCTION)
        self.assertEqual(movements[2].movement_type, MovementType.PHYSICAL_COUNT)

        # Verify chain: each after = next before
        self.assertEqual(movements[0].quantity_after, movements[1].quantity_before)
        self.assertEqual(movements[1].quantity_after, movements[2].quantity_before)
