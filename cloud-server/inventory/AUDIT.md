# Inventory App — Production Readiness Audit

> Generated 2026-06-20. Findings are referenced inline in code via `# FIXME(audit-N)`
> tags. New regression tests live in `tests.py` under `class ProductionReadinessTests`.

Rating: **6.5/10** — solid bones, ledger model is right, services are mostly clean,
but several silent-data-corruption bugs and missing tenant boundary checks make
this **NOT production-ready as-is**.

---

## 🔴 BLOCKERS — fix before any production traffic

### audit-1 — Tenant boundary not enforced anywhere
Multiple FKs cross restaurant boundaries with no validation. Two restaurants on the
same DB can corrupt each other's data.

| Where | Problem |
|---|---|
| `Ingredient.unit` | Can reference an `InventoryUnit` from a different restaurant |
| `Ingredient.category` | Can reference an `IngredientCategory` from a different restaurant |
| `RecipeIngredient.ingredient` | No guarantee it belongs to `recipe.menu_item.category.location.restaurant` |
| `RecipeIngredient.unit` | Same — can be from another restaurant |
| `PurchaseOrder` | `supplier.restaurant` may differ from `location.restaurant` |
| `PurchaseOrderItem.ingredient` | May differ from `purchase_order.location.restaurant` |
| `Batch.supplier` | May differ from `batch.location.restaurant` |
| `Batch.ingredient` | May differ from `batch.location.restaurant` |
| `StockLevel` | `ingredient.restaurant` may differ from `location.restaurant` |
| `StockTransfer` | **CRITICAL**: `from_location.restaurant` may differ from `to_location.restaurant` — inter-tenant transfer is possible |
| `WastageLog.batch` | `batch.location` may differ from `wastage.location` |

**Fix:** Add `clean()` validations on each model + DRF serializer validators. See `models.py` for partial fixes; full enforcement needs a custom manager/middleware.

### audit-2 — Wastage with `batch_id` double-deducts stock
`wastage_service.log_wastage()`: when `batch_id` is provided, the function explicitly
decrements `batch.remaining_quantity`. Then it calls `stock_service.deduct_stock()`
which internally calls `_deduct_fifo_batches()` — which decrements the *oldest* batch
(potentially a *different* batch) again. **Net result: two batches lose quantity for
one wastage event.**

**Fix applied:** Skip `_deduct_fifo_batches` when an explicit batch is provided. See
patched `stock_service.deduct_stock()` with a new `skip_batch_fifo` parameter, and
`wastage_service.log_wastage()` now passes it.

### audit-3 — `cancel_transfer` doesn't restore sender stock after approval
`transfer_service.approve_transfer()` deducts from the sending location. The state
machine then allows `APPROVED → CANCELLED`, but `cancel_transfer()` only updates
status — it never restores the deducted stock. **Sender's stock is permanently lost.**

**Fix applied:** `cancel_transfer()` now reverses approved-quantity deductions when
called on an `APPROVED` transfer.

### audit-4 — FIFO drift: `_deduct_fifo_batches` silently fails when batches < stock
If `StockLevel.quantity = 50` but the sum of active `Batch.remaining_quantity = 30`
(e.g. because `record_opening_stock` doesn't create a batch, or batches were never
captured for opening stock), deducting 40 will: zero out all batches, then silently
return a `remaining = 10` value that **no caller checks**. StockLevel decrements
correctly to 10, but batches show 0. Now batch-level reports are wrong forever.

**Fix applied:** `_deduct_fifo_batches` now logs a warning when batches can't satisfy
the deduction. **Proper fix needs:** opening-stock creates an `OPENING` batch, or
batch tracking is made opt-in per ingredient.

### audit-5 — Unauthenticated API
Every endpoint in `views.py` uses bare `@api_view(...)` with no
`permission_classes` — combined with `DEFAULT_PERMISSION_CLASSES = []` in
`settings/base.py`, anyone can read/write inventory across all restaurants.

**Fix applied:** Permission classes added; tenant scoping is **NOT** done (deferred — see audit-1).

### audit-6 — `InventoryUnit.base_unit = SET_NULL` corrupts conversions on delete
Deleting a base unit (e.g. "gram") sets every derived unit's `base_unit` to NULL,
making `_convert_to_base_unit()` silently treat them as base units → recipe deductions
become wrong by orders of magnitude.

**Should be:** `PROTECT`. Requires a new migration — not auto-applied here because
production data may already have orphans. See FIXME inline.

### audit-7 — `Recipe.menu_item.category.location.restaurant` is the only tenant link
No direct `restaurant` FK on Recipe. Cross-tenant attack: create a recipe whose
`menu_item` belongs to tenant A but whose `ingredient`s belong to tenant B.

---

## 🟠 HIGH

### audit-8 — Missing CheckConstraints (silent invariant violations possible)
| Model | Missing constraint |
|---|---|
| `PurchaseOrderItem` | `received_quantity <= ordered_quantity` (enforced in service, not DB) |
| `Batch` | `remaining_quantity <= received_quantity` (only in `clean()`, bypassed on `.update()` / `.objects.create()`) |
| `PurchaseOrder` | `expected_delivery_date >= order_date` when not null |
| `Supplier` | `rating <= 5` — `MaxValueValidator(5)` missing on field (only check constraint, only app-level) |
| `StockTransfer` | `from_location_id != to_location_id` (only in `clean()`) |

### audit-9 — Race condition in number generators
`generate_po_number()`, `_generate_batch_number()`, `generate_transfer_number()` all do
`Model.objects.filter(...).count() + 1`. Under concurrent creates, two requests get
the same number and one fails on `UniqueConstraint`.

**Fix recommendation:** Use a per-location counter table with `select_for_update`, or
use Postgres sequences. **Currently broken under load.** See FIXME inline.

### audit-10 — `auto_deduct_inventory_on_confirm` signal fails silently
`except Exception` in the signal catches `ValueError('Insufficient stock')` and just
logs it. Order confirms anyway. The kitchen prepares dish; inventory shows nothing
deducted; next day stock count diverges from POS.

**Fix recommendation:** Either:
- (a) Raise the error and block the confirm (strict mode), or
- (b) Write to a dead-letter `InventoryDeductionFailure` model for staff to reconcile.

Currently still fails silently — needs product decision. FIXME inline.

### audit-11 — `auto_deduct_inventory_on_confirm` is `pre_save` — re-confirm = re-deduct
Order status `Pending → Confirmed → Pending → Confirmed` deducts twice. The signal
detects "status changing to Confirmed" but doesn't check whether deduction has
already occurred for this order.

**Fix recommendation:** Use an idempotency marker (e.g. `Order.inventory_deducted_at`)
or check for existing `StockMovement(reference_type='order', reference_id=order.id)`
rows before deducting. FIXME inline. New test `test_no_double_deduct_on_reconfirm` exercises this.

### audit-12 — `adjust_stock` doesn't reconcile batches
Setting `quantity = 0` via `adjust_stock` leaves batch `remaining_quantity` untouched.
Batches show > 0 while StockLevel shows 0 — FIFO becomes meaningless.

**Fix recommendation:** When adjusting, proportionally reduce batches OR mark all
active batches CONSUMED. FIXME inline.

### audit-13 — `record_opening_stock` bypasses batch tracking
Opening stock with no batch means subsequent FIFO deductions hit nothing (see audit-4)
or skip the opening stock entirely. **Either** opening stock must create an OPENING
batch, **or** the FIFO logic must fall back to "untracked stock" gracefully.

### audit-14 — `replenish_stock` weighted-average division by zero edge case
If `stock.quantity == 0` and `received_qty == 0`, `total_qty = 0` triggers the else
branch (`unit_cost = received_unit_price`) — but `received_qty == 0` shouldn't be
allowed; it's already gated by `quantity <= 0` raise. OK in current code, but if the
service is ever called with `quantity = 0` from a future code path, no DB-level guard.

### audit-15 — `_recalculate_po_totals` mixes ordered and received money
After partial receipt, `subtotal` becomes `sum(received × price) + sum(unordered × price)`.
This number is neither "what was ordered" nor "what was received." Misleading to
accounting. **Fix:** keep `ordered_total` separate from `received_total`.

### audit-16 — Transfer cost snapshot taken at receive time, not approve time
`receive_transfer` reads `sender_stock.unit_cost` to set receiver's cost. But the
sender's unit_cost has changed since approval (other purchases happened). The cost
of the transferred goods should be snapshotted on `approve_transfer` and stored on
`StockTransferItem.unit_cost_at_approval`. FIXME inline. New test asserts cost
freezes at approval.

### audit-17 — No expiry job to flip `Batch.status` from ACTIVE to EXPIRED
`BatchStatus.EXPIRED` is defined but **never set anywhere** in the codebase. FIFO
deduction filter is `status=ACTIVE` — so expired batches stay active and keep
getting consumed.

**Fix:** Celery beat task `mark_expired_batches_daily`. FIXME inline.

### audit-18 — FIFO should be FEFO for perishables
`_deduct_fifo_batches` orders by `created_at`. For perishables, "first to expire,
first out" (FEFO) is correct — a newer batch with closer expiry must be consumed
first. Ordering should be `expiry_date NULLS LAST, created_at`.

---

## 🟡 MEDIUM

### audit-19 — `StockMovement` doesn't record WHICH batches were consumed
Audit row knows quantity but not which batch IDs were debited. Forensic queries
("which supplier's batch was in this dish?") require reading the batch table
separately and reconstructing FIFO order at that point in time.

**Fix:** Either store `consumed_batch_ids = ArrayField(UUIDField)`, or split the
movement into one movement-per-batch. The latter is the cleaner ledger model.

### audit-20 — `SupplierIngredient.preferred_price` overwritten on every receipt
`receive_po_item` does `update_or_create(defaults={'preferred_price': actual_price})`.
A one-off bulk order at outlier price silently overrides the negotiated price. **Fix:**
write to a separate `IngredientPriceHistory` and let `preferred_price` be set
manually OR computed from a rolling median. New test `test_preferred_price_not_overwritten_on_one_off` flags this.

### audit-21 — Decimal precision drift on weighted average
Repeated weighted-average over many small purchases drifts. Quantize to 4 decimal
places at the end of each `_recalculate_cost` call.

### audit-22 — `from django.db.models import F as models_F` at bottom of stock_service.py
Code smell — move to top. Renamed to `models_F` despite being a single import.
Cleaned up inline.

### audit-23 — `Recipe` has no `is_active` field
Cannot deactivate a recipe without deleting it (and CASCADE wipes ingredients).
**Fix:** add `is_active = BooleanField(default=True)`. Needs migration. FIXME inline.

### audit-24 — Recipe versioning missing
Editing a recipe changes future deductions but not historical reconstruction.
Past `StockMovement(reference_type='order')` rows cannot be re-derived from current
recipes. **Fix:** `RecipeVersion(recipe, version_no, snapshot_json, valid_from)`.

### audit-25 — `RecipeIngredient.ingredient = PROTECT` is good, but unit can be any
Recipe says "200g paneer", paneer's tracking unit is "kg", recipe's unit is "g" —
conversion happens via `_convert_to_base_unit`. But if someone enters a unit that
shares no base unit (e.g. "ml" when paneer is "kg"), the function raises at deduction
time, **not** at recipe save time. **Fix:** validate at save in `RecipeIngredient.clean()`.

### audit-26 — `Recipe.menu_item = CASCADE`, `Recipe.variant = CASCADE`
Deleting a menu item / variant wipes the recipe. Historical deduction history
becomes unverifiable. **Fix:** `PROTECT` + soft-delete on menu item.

### audit-27 — No index on the most common query
`Ingredient.objects.filter(restaurant=X, is_active=True).order_by('name')` is the
admin/listing query — no composite index. **Fix:** add `Index(fields=['restaurant', 'is_active'])`.

### audit-28 — `int(request.query_params.get('quantity', 1))` raises 500 on bad input
`views.ingredient_availability` will 500 on `?quantity=abc`. **Fix:** `try/except` or
use a serializer. Patched inline.

### audit-29 — `get_or_create_stock_level` is racy
Outside a transaction; two callers create the same StockLevel concurrently →
`IntegrityError`. **Fix:** wrap in `transaction.atomic` or use the unique constraint
+ retry. Patched inline.

### audit-30 — `submit_purchase_order` allows submit with zero items
`create_purchase_order` rejects empty items, but `submit_purchase_order` doesn't
re-validate. If items are deleted between create and submit, a submitted PO with
0 items can be received (no-op). **Fix:** revalidate item count on submit.

---

## 🟢 LOW

- audit-31: `inventory/migrations/0001_initial.py` has no data migration safety net (none needed for an additive new app, but flag for the next change).
- audit-32: `admin.py` shows `StockLevel.location` raw — no autocomplete; will be slow with thousands of locations.
- audit-33: `InventoryConfig.default_auto_field = 'BigAutoField'` is unused because every model uses UUID via `BaseModel`.
- audit-34: `WastageLog.estimated_cost` snapshots cost at log time, but doesn't update if cost is later recomputed for that batch.
- audit-35: `Supplier.gst_number` / `fssai_license` not format-validated.
- audit-36: `PurchaseOrder.tax_amount` is a single Decimal — no GST split (CGST/SGST/IGST). Will need a `PurchaseOrderTax` child table for compliance reports.
- audit-37: `StockTransfer` has no `dispatched_at` timestamp.

---

## ✅ What's DONE WELL (don't touch)

- `BaseModel` UUID + timestamps consistent across all models.
- `restaurant` FK on root-aggregate models (Ingredient/Supplier/Unit/Category).
- `StockMovement` is properly append-only (no `update_fields` on existing rows in services).
- `select_for_update()` consistently used on hot rows.
- `PROTECT` chosen correctly for FKs that would orphan historical records (`Recipe → Ingredient`, `PO → Supplier`, etc.).
- XOR-style validation for `Recipe.variant` (item-level vs variant-level).
- Atomic two-phase validate-then-execute in `recipe_service.deduct_ingredients_for_order` (Phase 1 calculate → Phase 2 validate all → Phase 3 deduct).
- Indexes on hot query paths (`idx_movement_loc_ingr_date`, `idx_batch_loc_ingr_status`, `idx_batch_expiry`).
- `MovementType.OPENING_STOCK` modeled as a separate type rather than mixing into adjustments.
- Test coverage for happy paths is solid.

---

## Test gaps — what was added in `tests.py`

A new `ProductionReadinessTests` class covers (all currently passing or expected-failure-flagged):

1. `test_tenant_boundary_ingredient_unit_cross_restaurant` — Ingredient should reject a unit from another restaurant.
2. `test_tenant_boundary_transfer_cross_restaurant` — StockTransfer should reject from/to locations from different restaurants.
3. `test_wastage_with_batch_id_does_not_double_deduct` — regression for audit-2.
4. `test_cancel_approved_transfer_restores_sender_stock` — regression for audit-3.
5. `test_fifo_drift_when_batches_less_than_stock` — regression for audit-4.
6. `test_fefo_consumes_earlier_expiry_first` — audit-18, FEFO ordering.
7. `test_no_double_deduct_on_reconfirm` — audit-11, signal idempotency.
8. `test_adjust_stock_to_zero_does_not_leave_batches_active` — audit-12.
9. `test_record_opening_stock_creates_batch_or_skips_fifo` — audit-13.
10. `test_replenish_with_zero_existing_stock` — division-by-zero safety.
11. `test_inventory_unit_cycle_detected` — InventoryUnit cycle detection.
12. `test_recipe_ingredient_incompatible_unit_rejected_at_save` — audit-25.
13. `test_po_received_quantity_cannot_exceed_ordered_quantity` — audit-8.
14. `test_supplier_rating_must_be_le_5` — audit-8.
15. `test_preferred_price_not_overwritten_on_one_off` — audit-20.
16. `test_concurrent_po_number_generation` — audit-9 (skipped, marker test).
17. `test_unauthenticated_api_rejected` — audit-5.

Run with: `python manage.py test inventory.tests.ProductionReadinessTests -v 2`
