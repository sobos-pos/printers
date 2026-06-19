# Soboss POS — Sections, Kitchens, KOTs & Bills: Routing Architecture

This document defines how **floors/sections**, **kitchens**, **KOTs** and **bills** relate, and
the architecture change needed so that:

- a table's order produces **one consolidated bill** but **as many KOTs as there are kitchens**,
- two different tables/bills can still share **the same kitchen** (same KOT printer), and
- different sections can serve **different menus** without duplicating the catalogue.

Scope is the **cloud server** (`cloud-server/`, source of truth) and the **node app**
(`main-node/`, the leader/follower that actually prints). The mobile/floor app is out of scope here.

---

## 0. TL;DR — the one decision that fixes everything

**Today a single field — `MenuItem.station` — does two unrelated jobs at once:** it decides which
kitchen ticket (KOT) an item lands on *and* it is (mis)used to split the bill. Those are two
different axes and must be separated.

> **Split the one "station" axis into two independent routing axes:**
>
> | Axis | Answers | Driven by | Print type | Cardinality per order |
> |------|---------|-----------|------------|------------------------|
> | **Kitchen** | *Where is this dish cooked / which KOT prints it?* | the **dish** (category, item override) | `KOT` | **many** (one KOT per kitchen) |
> | **Section** (Floor) | *Where does the customer's bill print / who serves it?* | the **table** (its section) | `BILL` | **one** (one bill per order) |

Once KOT routing is keyed by **kitchen** and BILL routing is keyed by **section**, every scenario
the question raises falls out naturally — and the existing `(station_code, print_type)` routing
table already supports it with almost no schema change (see §5).

---

## 1. What exists today (verified against the code)

### 1.1 Cloud data model
| Concept | Where | Shape | Gap |
|---|---|---|---|
| Table | [tables/models.py](cloud-server/tables/models.py) | `(location, label)` — **flat** | no floor/section |
| Printer station | [menu/models.py](cloud-server/menu/models.py#L244) `PrinterStation` | `(location, name, code)` | single generic "station", no kitchen vs bill distinction |
| Menu item → station | [menu/models.py](cloud-server/menu/models.py#L328) `MenuItem.station` | one nullable FK per item | item-only; no category default; **conflates KOT routing with billing** |
| Order | [orders/models.py](cloud-server/orders/models.py#L6) | one `total`, one `table` | fine — one order = one bill (good) |
| Print route | [core/models.py](cloud-server/core/models.py#L114) `PrintRoute` | `(location, station_code, print_type[KOT\|BILL]) → assigned_node` | **already the right shape** — keyed per type |

### 1.2 How a KOT is built today
[`KOTService.build_kot`](cloud-server/orders/services/kot_service.py#L9) and the node's
[`kotService.buildKot`](main-node/src/main/services/kotService.ts#L6) both **group order items by
`menu_item.station.code`** into "segments" (default `'KITCHEN'` when unset). One segment ⇒ one KOT.
That part is correct and already supports "one order → multiple kitchen tickets."

### 1.3 How the bill is "built" today — the bug
In [`orderService.ts`](main-node/src/main/services/orderService.ts#L146-L157) the node does:

```ts
const kot = kotService.buildKot(order)            // segments grouped by station
printService.enqueueSegments(orderId, kot.segments, 'KOT',  …)   // 1 KOT  per station ✔
printService.enqueueSegments(orderId, kot.segments, 'BILL', …)   // 1 BILL per station  <-- BUG
```

So a **BILL is emitted per station segment**, and
[`formatBillReceipt`](main-node/src/main/services/kotFormatter.ts#L88) prints `"<station> station"`
with a **per-station subtotal**. An order spanning 3 kitchens prints **3 partial bills**, each
totalling only its own station — never one bill for the table. This is the core problem.

### 1.4 How routing/forwarding works today (keep this — it's good)
- Cloud `PrintRoute` and the node mirror `print_route_nodes`
  ([004](main-node/src/main/db/migrations/004_print_routes.ts),
  [printRouteRepository.ts](main-node/src/main/repositories/printRouteRepository.ts)) map
  **`(station_code, print_type) → node`**.
- The leader, in [`processDueJobs`](main-node/src/main/services/printService.ts#L74), forwards each
  job to the assigned follower node for that `(station, type)`, falling back to local print if the
  node is offline; the node's local `print_routes` table maps `(station, job_type) → physical
  printer`.

**This two-level routing (`code+type → node → printer`) is exactly what we need.** We are *not*
changing the transport — only *what the code means*: a kitchen code for KOT rows, a section code
for BILL rows.

---

## 2. The model: Section and Kitchen as two orthogonal axes

```
        DISH AXIS (KOT)                              TABLE AXIS (BILL)
   MenuItem.kitchen ?? Category.kitchen          Table.section
            │                                          │
            ▼                                          ▼
        Kitchen.code  ──┐                         Section.code ──┐
                        │  print_type = KOT                      │  print_type = BILL
                        ▼                                        ▼
            PrintRoute (location, code, type) → node → physical printer
```

- **Section (Floor)** — a grouping of tables (Ground Floor, Rooftop, Bar…). Carries the **bill
  routing** (`section.code` → BILL printer/node) and **scopes which menu is sellable there** (§4).
- **Kitchen** — a place where dishes are cooked (Main Kitchen, Tandoor, Bar, Bakery…). Carries the
  **KOT routing** (`kitchen.code` → KOT printer/node). A dish points at a kitchen via its
  **category** (default) with an optional **per-item override**.

These two never mix: a dish's kitchen is independent of the table's section.

### Why this solves each scenario

| Requirement | How it works |
|---|---|
| **Same bill, different KOTs** | One order at table T (section S). Items resolve to kitchens K1, K2, K3 ⇒ **3 KOTs** routed by kitchen code. **1 BILL** routed by S. |
| **Different bills, same KOT** | Table A∈S1 and Table B∈S2 both order a tandoor dish ⇒ both KOTs carry kitchen code `TANDOOR` ⇒ **same KOT printer**. Two separate orders ⇒ **two bills** (S1 printer, S2 printer). |
| **A menu item belongs to one kitchen** | `item.kitchen ?? category.kitchen` gives a deterministic kitchen per line; the KOT segment for that kitchen is the request "sent to that kitchen." |
| **Sections serve different menus** | Section-scoped availability (§4): the same catalogue, filtered per section. "Some sections have it, some don't" = an availability row, not a duplicated menu. |
| **Takeaway / QR / no table** | Order has no section ⇒ bill routes to a **default section** (e.g. `COUNTER`). KOT routing is unaffected. |

---

## 3. Data model changes (cloud server)

Additive migrations; nothing about orders/totals changes.

### 3.1 New: `tables.Section`
```python
class Section(BaseModel):                 # a.k.a. Floor
    location = FK(core.Location, related_name='sections')
    name = CharField(80)
    code = CharField(20)                  # routing key for BILL (e.g. 'GROUND', 'ROOF')
    display_order = PositiveIntegerField(default=0)
    is_active = BooleanField(default=True)
    class Meta:
        constraints = [UniqueConstraint(fields=['location', 'code'], name='uniq_section_code')]
```
Add to `Table`:
```python
section = FK(Section, null=True, blank=True, on_delete=SET_NULL, related_name='tables')
```
> Migration backfill: create one default Section per location and assign all existing tables to it,
> so behaviour is unchanged until sections are configured.

### 3.2 New: `menu.Kitchen` (and keep `PrinterStation` as the physical target, or rename)
Two clean options — **recommended: introduce `Kitchen` as the KOT routing entity** and keep
`PrinterStation` strictly as a *physical destination* concept (it already maps to nodes/printers):

```python
class Kitchen(BaseModel):
    location = FK(core.Location, related_name='kitchens')
    name = CharField(40)
    code = CharField(20)                  # routing key for KOT (e.g. 'MAIN','TANDOOR','BAR')
    is_active = BooleanField(default=True)
    class Meta:
        constraints = [UniqueConstraint(fields=['location', 'code'], name='uniq_kitchen_code')]
```
Map dishes to kitchens at the **category** level with an item override:
```python
# MenuCategory
kitchen = FK(Kitchen, null=True, blank=True, on_delete=SET_NULL, related_name='categories')
# MenuItem  (override; keep nullable)
kitchen = FK(Kitchen, null=True, blank=True, on_delete=SET_NULL, related_name='items')
```
**Resolution rule (single source of truth, implement once):**
```
kitchen_code(item) = item.kitchen?.code  ?? item.category.kitchen?.code  ?? 'KITCHEN'
```
> Migration: if you prefer not to add a new table, you may instead *reuse* `PrinterStation` as the
> kitchen and add `MenuCategory.station`. Either way the **invariant is: KOT routing is resolved
> from the dish's category (item override allowed), not from a flat per-item field alone.**

### 3.3 Section-scoped menu availability (§4 details the policy)
```python
class SectionMenuAvailability(BaseModel):
    section  = FK(Section, related_name='menu_availability')
    category = FK(menu.MenuCategory, null=True, blank=True)   # category-level toggle
    item     = FK(menu.MenuItem,     null=True, blank=True)   # item-level toggle (overrides)
    is_available = BooleanField(default=True)
    class Meta:
        constraints = [CheckConstraint(category XOR item),
                       UniqueConstraint(section, category), UniqueConstraint(section, item)]
```

### 3.4 `PrintRoute` — no structural change
`PrintRoute(location, station_code, print_type)` stays as-is. We simply populate it with:
- `print_type = KOT` rows keyed by **kitchen codes**, and
- `print_type = BILL` rows keyed by **section codes**.

(If you want stronger validation, add a `route_kind` enum, but it is not required.)

---

## 4. Section-scoped menus ("some sections have it, some don't")

> **Updated by §10.4:** the deny-list / Menu-Profile options below are the *minimal* form. Once
> sections need the **same item at different prices** (Case 5), promote this to a first-class
> `Menu` + `MenuListing(menu, item, price_override)` model and a `SectionMenu` link — that is the
> adopted design. Read this section for the policy/resolution rules, §10.4 for the entities.

Default policy: **everything is available everywhere unless a row says otherwise** (deny-list),
which keeps the common case zero-config. Resolution for "is item I sellable in section S":

```
available(S, I) =
    item-level row for (S, I)            if present      # most specific wins
 else category-level row for (S, I.cat)  if present
 else True                                                # default available
```

- **Reads:** the menu API (`menu_service` / the menu cache the node serves) takes an optional
  `section` and filters categories/items by `available(section, …)` before returning. The waiter UI
  for a table in section S therefore only ever shows S's menu.
- **Writes/validation:** `OrderService.create_order` must reject (or warn) a line whose item is not
  `available(table.section, item)` — otherwise a section that "doesn't have" an item could still be
  ordered via a stale client. This is the authoritative guard.
- **Alternative if sections diverge a lot:** assign each section a named **Menu Profile** (a set of
  categories) instead of per-item toggles. Same idea, coarser granularity — choose per how
  different the floors really are. Recommended default is the deny-list above; reach for profiles
  only when whole menus differ.

---

## 5. Printing flow after the change (node app)

Change is concentrated in two functions; the transport/forwarding in
[`processDueJobs`](main-node/src/main/services/printService.ts#L74) is untouched.

### 5.1 KOT — group by **kitchen** (rename of today's station grouping)
`buildKot` keeps grouping into segments, but the segment key becomes the resolved **kitchen code**
(§3.2) instead of the flat item station. One segment per kitchen ⇒ one KOT each.

### 5.2 BILL — emit **one consolidated job per order**, keyed by **section**
Replace the per-segment BILL loop with a single bill built from **all** order lines:

```ts
// orderService.ts  (was: enqueueSegments(... 'BILL') over kot.segments)
const kot = kotService.buildKot(order)                  // KOTs, grouped by kitchen
printService.enqueueSegments(orderId, kot.segments, 'KOT', meta)

const sectionCode = resolveSectionCode(order)           // table.section.code ?? 'COUNTER'
const billSegment = {
  station: sectionCode,                                 // BILL routes by section now
  lines: order.items.map(toBillLine),                   // ALL lines, full order total
}
printService.enqueueBill(orderId, billSegment, { table, placedAt, total: order.total })
```

And [`formatBillReceipt`](main-node/src/main/services/kotFormatter.ts#L88) prints the **order
total** (the order already carries one `total`) instead of summing a single station's lines, and
shows the section/table instead of `"<station> station"`.

> Net effect: **N kitchens ⇒ N KOTs + exactly 1 bill**, the bill routed to the section's bill
> printer/node, each KOT routed to its kitchen's printer/node.

### 5.3 Node-side schema touch-ups
- `print_route_nodes` ([004](main-node/src/main/db/migrations/004_print_routes.ts)) and local
  `print_routes` ([001](main-node/src/main/db/migrations/001_initial.ts#L83)) are unchanged in
  shape — they now simply hold kitchen codes (KOT) and section codes (BILL).
- Seed defaults (`seedPrinters.ts`) should seed a `('COUNTER','BILL')` and `('KITCHEN','KOT')`
  route so a brand-new single-printer install still works.

---

## 6. The management surface (who configures what)

Exposed by the cloud server (admin web app) and synced to nodes via the existing config sync:

1. **Sections** — CRUD; assign tables to a section.
2. **Kitchens** — CRUD; assign each menu **category** to a kitchen (+ optional per-item override).
3. **Section menus** — per-section availability toggles (or assign a Menu Profile).
4. **Print routing** — for each **kitchen code** (`KOT`) and each **section code** (`BILL`), pick
   the **node** that prints it (existing `PrintRoute` editor), and on each node map that code+type
   to a **physical printer** (existing local `print_routes`).

This is the chain end-to-end:
```
dish → category.kitchen → kitchen.code ─(KOT)─┐
table → section → section.code ──────(BILL)───┤→ PrintRoute → node → printer
```

---

## 7. Migration & backward compatibility

1. Add `Section` + `Table.section`; backfill one default section per location, assign all tables.
2. Add `Kitchen` + `MenuCategory.kitchen` (+ `MenuItem.kitchen` override). Backfill: for each
   existing `MenuItem.station`, create/find a matching `Kitchen` and set the item/category kitchen
   so current KOT behaviour is preserved.
3. Switch `buildKot` grouping key from station to resolved kitchen code (behaviour identical after
   step 2's backfill).
4. **Switch BILL from per-segment to one-per-order** keyed by section code — this is the only
   behaviour change users will see (one correct bill instead of several partial ones).
5. Add `SectionMenuAvailability` (default-available ⇒ no behavioural change until configured).
6. Keep `PrinterStation`/`PrintRoute`/forwarding as-is; only the *meaning* of `station_code`
   broadens to "kitchen code (KOT) or section code (BILL)."

Each step is independently shippable; the system keeps working between steps.

---

## 8. Build order (suggested)

1. **Bill fix first** (highest value, smallest change): consolidate BILL to one-per-order keyed by
   the table's section code (with a default `COUNTER` when no section). Fixes the partial-bill bug.
2. **Kitchen model**: add `Kitchen` + category mapping + resolution rule; repoint KOT grouping.
3. **Section model**: add `Section` + `Table.section`; wire bill routing to section codes.
4. **Section-scoped menus**: availability table + menu read filter + order-time guard.
5. **Admin UI**: sections, kitchens, category→kitchen, per-section availability, routing editors.

---

## 9. Glossary

| Term | Meaning | Routes | Print type |
|---|---|---|---|
| **Section / Floor** | grouping of tables; billing & service zone | `section.code` | `BILL` (one per order) |
| **Kitchen** | where a dish is cooked | `kitchen.code` (via category/item) | `KOT` (one per kitchen) |
| **PrinterStation** | a physical print destination abstraction | target of `PrintRoute` | — |
| **PrintRoute** | `(location, code, type) → node`; node maps code+type → printer | — | both |
| **KOT** | kitchen ticket, unpriced, per kitchen | by kitchen code | `KOT` |
| **BILL** | priced receipt, one per order/table | by section code | `BILL` |

---

## 10. Case ladder — what works today vs. what's needed

### 10.1 Terminology bridge (read first)

The case ladder below uses **"Station"** to mean a *floor/visibility grouping* — which is the
**Section/Floor** entity from §2. To avoid a name clash, note:

| Ladder term | This doc / code | Means |
|---|---|---|
| **Station** | **Section** (§3.1) | floor/waiter grouping; decides **visibility** (what a table can see/order). **Not** the code's `PrinterStation`, which is a *physical printer destination*. |
| **Menu** | **`Menu` + `MenuListing`** (new, §10.4) | a first-class catalogue/price-list assigned to a Station; items join menus **many-to-many** with a **per-menu price override**. This **supersedes the deny-list/Menu-Profile idea in §4** — adopt `MenuListing` instead. |
| **Kitchen** | **Kitchen** (§3.2) | preparation target; decides where it's cooked → drives the KOT. |
| **Bill** | **Order → Table** | always keyed to the order/table; never to Menu or Station. |

**The invariant across every case:** three **independent axes** —
**visibility** (Station → Menu), **preparation** (Kitchen), **billing** (Order/Table).
Treat them as three axes, not one chained FK, and every case is just a different combination.

### 10.2 The case ladder (reference)

| Case | Stations | Kitchens | Menus | Routing rule | Schema implication |
|---|---|---|---|---|---|
| **1. Simple** | 1 | 1 | 1 | Every order → the one kitchen | Flat chain `Table→Station→Kitchen→Menu`; no routing logic needed. |
| **2. Medium (shared everything)** | N | 1 shared | 1 shared | All stations feed the same kitchen & menu | `Station` is just a floor/waiter grouping — irrelevant to KOT routing. |
| **3. Complex (fully siloed)** | N | N (1 per station) | N (exclusive) | Station's orders → only its own kitchen | `Station.kitchen_id`, `MenuItem.menu_id` (exclusive); order screen filters by table's station. |
| **4. Real-world mixed (item-level)** | N | M (M<N, some shared) | items span menus | Routing moves station-level → **item-level** | `MenuItem.kitchen_id` (not `Station.kitchen_id`); one order splits into multiple KOTs. |
| **5. Overlapping menus, 1 kitchen** (Janatha/Premium Bar) | N | 1 | N, shared + exclusive items | Kitchen constant; routing is a non-issue | `MenuListing(menu_id, item_id, price_override)` M2M — same item, different price per menu; kitchen FK on item untouched. |
| **6. Multi-kitchen + overlapping menus** (hardest) | N | M | items span menus **and** route to different kitchens | Two axes at once: visibility (menu) + preparation (kitchen) | `MenuListing` (item↔menu M2M) **+** `MenuItem.kitchen_id` (item↔kitchen). Order splits into N KOTs; bill stays single. |
| **7. Multi-branch chain** | per-branch any of 1–6 | — | — | Branch A may be Case 2, Branch B Case 6 | Every config (`Station`, `Kitchen`, `Menu`, `MenuListing`) scoped to **Branch** (`Location`), not global. |

### 10.3 Coverage today & recommendation (✅ have it · ❌ missing · ⚠️ partial)

| Case | ✅ Satisfied today | ❌ Not satisfied today | 🛠 Recommendation |
|---|---|---|---|
| **1. Simple** | ✅ Single catalogue per location · ✅ one `Order.total` · ✅ KOT to default `KITCHEN` · ✅ effectively one bill (only 1 station) | — (nothing material) | **Works as-is.** No change needed. |
| **2. Medium** | ✅ Single menu · ✅ single-kitchen KOT funnels correctly | ❌ No `Section` entity to group tables by floor · ❌ can't route a floor's BILL to a floor-local printer | Add `Section` + `Table.section` (§3.1). Route BILL by `section.code` (§5.2). Kitchen stays single. |
| **3. Complex (siloed)** | ✅ Per-item KOT grouping exists (via `menu_item.station`) | ❌ No `Section`/`Kitchen`/`Menu` entities · ❌ no `Section→Menu` link · ❌ order screen can't filter by table's section | Add `Section`, `Kitchen`, `Menu`; assign one Menu per Section; filter the menu read by `table.section`'s menu (§4 → §10.4). |
| **4. Real-world mixed** | ✅ **Already splits one order into multiple KOTs** by item (segment grouping) | ❌ Routing key is `item.station`, not `item.kitchen` (no category default) · ❌ no `Kitchen` entity · ❌ BILL still emitted per-station (bug §1.3) | Adopt `MenuItem.kitchen ?? category.kitchen` (§3.2); **consolidate BILL to one-per-order** (§5.2). This is the core fix. |
| **5. Overlapping menus, 1 kitchen** | ✅ Single kitchen needs no routing | ❌ **No `Menu` entity** · ❌ no `MenuListing` M2M · ❌ `Variant.price` is one absolute price — **same item can't carry two prices** for two menus | Add `Menu` + `MenuListing(menu, item, price_override)` (§10.4). Same item lists into Janatha *and* Premium at different prices; kitchen FK on the item is untouched. |
| **6. Multi-kitchen + overlapping menus** | ⚠️ Multi-KOT split exists (partial) · ✅ `Order.total` is single | ❌ Needs **both** `MenuListing` (visibility) **and** `MenuItem.kitchen` (prep) — neither is fully present · ❌ BILL per-station bug | Combine Case 4 + Case 5: `MenuListing` **+** `MenuItem.kitchen` + consolidated BILL keyed to `Order→Table`. Fully decoupled axes. |
| **7. Multi-branch chain** | ✅ **Branch scoping already exists** — `Restaurant→Location`; `Section`/`Kitchen`/`Menu`/`PrintRoute` all FK to `Location` | ⚠️ Only a risk: if any new entity were made global instead of `Location`-scoped | Keep **every** new entity FK'd to `Location` (= branch). Restaurant = tenant, Location = branch. No global menu/kitchen assumption — branches may differ in *topology*, not just data. |

### 10.4 The cumulative schema that covers all 7 cases

Building on §3, the full set (each row also satisfies every simpler case):

| Entity / field | Purpose | Axis | Covers cases |
|---|---|---|---|
| `Section(location, code)` + `Table.section` | floor/visibility grouping; BILL routing key | visibility / billing | 2–7 |
| `Menu(location, name)` | a catalogue/price-list assigned to section(s) | visibility | 3,5,6,7 |
| `SectionMenu(section, menu)` | which menu(s) a section shows | visibility | 3,5,6,7 |
| `MenuListing(menu, item, price_override)` **(M2M)** | same item in many menus, per-menu price | visibility | 5,6,7 |
| `Kitchen(location, code)` | preparation target; KOT routing key | preparation | 3–7 |
| `MenuItem.kitchen` ⟵ `MenuCategory.kitchen` (item override, else category) | resolve a kitchen per dish | preparation | 4,6,7 |
| `PrintRoute(location, code, type)` — `code` = kitchen (KOT) or section (BILL) | code+type → node → printer (unchanged shape) | both | all |
| **One BILL per `Order` keyed by `table.section`** (§5.2) | single consolidated bill regardless of kitchens | billing | all |

> Net: **visibility = `Section → SectionMenu → Menu → MenuListing(price)`**, **preparation =
> `MenuItem.kitchen`**, **billing = `Order → Table → one BILL`**. All `Location`-scoped (branch).
> A given branch picks whichever subset it needs — Case 1 ignores most of it; Case 6 uses all of it.
