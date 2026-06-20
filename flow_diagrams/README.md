# Tables, Menu, Section, Kitchen & Printing — Flow Diagrams

This folder explains, with three diagrams, **how an order placed for a table turns into
printed tickets** in Soboss POS — and how Tables and the Menu are wired to **Sections**
(billing) and **Kitchens** (cooking).

Everything here was verified against the **current code** in `cloud-server/` (Django, the
source of truth) and `main-node/` (Electron/TypeScript, the leader/follower that actually
prints). The earlier design note `../stations_kitchen_priter_manage.md` proposed this model;
**it is now implemented** — these diagrams document the real, shipped behaviour.

## Open the diagrams

The `.flawlydiagram` files render in the **flawly** VS Code extension
(`saikethan.flawly`). Install it, then open any file in this folder to see the rendered
diagram. Each file's first line declares its type (flowchart / ERD / sequence).

| File | Type | Answers |
|------|------|---------|
| `01_order_to_print_flow.flawlydiagram` | Flowchart | *When I order an item for a table, how does it become prints?* |
| `02_data_model_erd.flawlydiagram` | ERD | *How are Tables & Menu connected to Section and Kitchen?* |
| `03_print_runtime_sequence.flawlydiagram` | Sequence | *What happens at runtime, step by step, across nodes?* |

---

## The one idea that makes all of it click

A dish's **kitchen** and a table's **section** are **two independent axes**. The old code
overloaded a single `MenuItem.station` field to do both jobs; the system now separates them:

| Axis | Question it answers | Driven by | Print type | How many per order |
|------|--------------------|-----------|------------|--------------------|
| **Kitchen** | *Where is this dish cooked / which KOT prints it?* | the **dish** (item → category) | `KOT` | **many** — one KOT per kitchen |
| **Section** (Floor) | *Where does the bill print / who serves it?* | the **table** | `BILL` | **one** — one bill per order |

A third axis, **visibility** (`Section → Menu → MenuItem`), decides *what a table can even
see/order* — but it does **not** affect routing.

> **Net rule:** *N kitchens involved in an order ⇒ N KOTs + exactly 1 consolidated BILL.*

---

## Diagram 1 — Order → Print Flow (flowchart)

**Read it top to bottom.** The order at the top forks into the two coloured axes, which
rejoin at the shared routing/printing steps.

- **Orange "KOT axis"** — for each item, resolve its kitchen with the rule
  `item.kitchen ?? category.kitchen ?? 'KITCHEN'`
  (`cloud-server/orders/services/kot_service.py`, `main-node/.../kotService.ts`). Items are
  grouped by kitchen code into **segments** — one KOT job per segment.
- **Green "BILL axis"** — the order's table resolves a section code
  `table.section.code ?? 'COUNTER'`. The whole order becomes **one** BILL job keyed by that
  section (`main-node/.../orderService.ts` → `enqueueBill`).
- **Violet routing (hexagon)** — both job types hit the same `PrintRoute` lookup keyed by
  `(location, code, print_type)`. The `code` is a **kitchen code** for KOT rows and a
  **section code** for BILL rows.
- **Diamond decision** — if that code is assigned to a *different* node and it's online, the
  **leader forwards** the job there; otherwise it prints **locally** (also the fallback when
  the assigned node is offline — no job is ever dropped).

**Shapes:** oval = start, diamond = decision, hexagon = routing step, document = the physical
printer, rectangle = a process step.

---

## Diagram 2 — Data Model (ERD)

**Read the arrows as "many-to-one":** `A.fk > B.id` means *many A rows point to one B row*.
Gold rows are primary keys, cyan rows are foreign keys.

Three coloured anchors mark the three axes; follow the FKs out from each:

- **Green `Section`** — the **billing/floor** axis. `Table.section_id → Section.id`.
  `Section.code` is the BILL routing key.
- **Orange `Kitchen`** — the **preparation** axis. `MenuCategory.kitchen_id → Kitchen.id`
  (the default) and `MenuItem.kitchen_id → Kitchen.id` (a per-item override).
  `Kitchen.code` is the KOT routing key.
- **Violet `PrintRoute`** — the routing table. Its `station_code` holds **either** a Kitchen
  code (for `print_type = KOT`) **or** a Section code (for `print_type = BILL`), and
  `assigned_node_id → LocationNode.id` says which node prints it.

The **visibility** chain `Section → SectionMenu → Menu → MenuListing → MenuItem` lets each
section show its own menu, and lets the same item appear in several menus at different prices
(`MenuListing.price_override`). `MenuItem.station_id` is the **legacy** field, kept only for
backward compatibility — kitchen routing now uses `Kitchen`.

Everything is scoped to **`Location`** (a branch), so different branches can have completely
different section/kitchen/menu topologies.

---

## Diagram 3 — Print Runtime (sequence)

**Read top to bottom = time.** Vertical lines are participants; arrows are messages
(solid `>` = call, dashed `-->` = response). Boxes are control flow.

1. The **Waiter app** posts an order to the **Leader node**.
2. The leader resolves the **section code**, runs `buildKot()` to group items **by kitchen**,
   then enqueues **one KOT job per kitchen** and **one BILL job** for the section, and
   immediately acknowledges the waiter.
3. `processDueJobs()` then handles each job. The `alt` block shows the three routing outcomes:
   - the code maps to **this** node → print locally (e.g. `MAIN → KitchenPrinter`);
   - the code maps to an **online follower** → the leader **forwards** the job over HTTP and
     the follower prints it (e.g. `BAR → BarPrinter`);
   - the assigned node is **offline** → fall back to local print.
4. The single **BILL** prints on the section's bill printer.
5. The leader **syncs** the order and its status up to the **Cloud** (via the SyncOutbox /
   status push), which is the source of truth.

---

## How to read flawly diagrams (quick legend)

| Element | Flowchart | ERD | Sequence |
|---------|-----------|-----|----------|
| `>` arrow | flow direction (with optional label) | many-to-one relationship | message from → to |
| `-->` arrow | (same, dashed) | soft/non-enforced FK | response / async |
| Colour | semantic grouping (orange=KOT, green=BILL, violet=routing) | anchors the 3 axes | per-participant identity |
| Box / group | sub-process container | a schema/group | `loop` / `alt` control flow |
| Diamond | a decision point | — | — |

**Colour key used across all three:** orange = **Kitchen / KOT**, green = **Section / BILL**,
violet = **routing & nodes**, blue = **table / item / waiter**, slate = **infra (cloud, node,
location)**.

---

## Source-of-truth references

- KOT grouping & section resolution: `cloud-server/orders/services/kot_service.py`,
  `main-node/src/main/services/kotService.ts`
- Enqueue KOT (per kitchen) vs BILL (one per order): `main-node/src/main/services/orderService.ts`,
  `printService.ts` (`enqueueSegments`, `enqueueBill`)
- Two-level routing (`code + type → node → printer`): `cloud-server/core/models.py` `PrintRoute`,
  `main-node/src/main/db/migrations/004_print_routes.ts`, `printRouteRepository.ts`
- Leader → follower forwarding & local fallback: `main-node/src/main/services/printService.ts`
  (`processDueJobs`), `clusterService.ts` (`forwardPrintJob`), `api/routes/cluster.ts`
- Data model: `cloud-server/tables/models.py` (`Section`, `Table`),
  `cloud-server/menu/models.py` (`Kitchen`, `MenuCategory`, `MenuItem`, `Menu`, `SectionMenu`,
  `MenuListing`)
