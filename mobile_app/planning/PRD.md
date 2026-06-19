# PRD — Soboss Mobile App (Waiter MVP)

**Status:** Draft · **Scope:** v1 (Waiter role only) · **Owner:** TBD

---

## 1. Summary

A mobile app for restaurant floor staff. **v1 ships exactly two capabilities for the Waiter
role:** (1) **Login** and (2) **Ordering** — show the menu, select a table, and place an order.

Other roles (kiosk, admin, printer station) and features (payments, order history, KDS view) are
explicitly **out of scope** for v1 but the app is structured so they can be added later without a
rewrite.

---

## 2. Goals & non-goals

### Goals (v1)
- A waiter can **log in** with their staff credentials.
- A waiter can **select a table**, **browse the menu** (categories, items, variants, modifiers),
  build an order, and **place it**.
- Ordering works against the **local leader node over the LAN** (fast, offline-tolerant), with a
  **cloud fallback** when the node is unreachable.

### Non-goals (v1)
- No kiosk / admin / super-admin / printer-station modes (later roles).
- No payments, bill splitting, discounts, refunds.
- No order editing after placement, no table/floor management, no KDS screen.
- No offline *creation* of new orders when **both** node and cloud are unreachable (we surface an
  error; true store-and-forward is a later milestone).

---

## 3. Target user & platform

- **User:** Waiter / floor staff on a handheld phone or small tablet.
- **Platform:** Native mobile (Android first; iOS-capable framework). Native is required so the app
  can later do **mDNS leader discovery** and run reliably on the floor Wi-Fi.
- **Network:** Same LAN/Wi-Fi as the leader node; cloud reachable when internet is up.

> **Why native, not the existing browser waiter page:** the browser `waiter_app` page cannot do LAN
> discovery or survive leader failover. The native app is the path to true offline resilience.

---

## 4. User flows (v1)

### 4.1 Login
1. App opens to a **Login** screen (email + password).
2. On submit → `POST /api/v1/auth/login/`.
3. On success, store the **session token** and the user's **restaurant/location** context; route to
   the ordering screen.
4. On failure (401) → inline "Invalid credentials" error.

### 4.2 Place an order
1. **Connection probe:** on entering the ordering screen (and every ~20s), probe the leader node's
   `GET /health/`.
   - Reachable → **Local mode** (orders + menu hit the node directly).
   - Unreachable → **Cloud mode** (hit the cloud). Show a clear mode badge (🟢 Local / 🟡 Cloud).
2. **Select table:** choose a dining table from the list.
3. **Browse menu:** `GET /api/v1/tables/{table_uuid}/menu/` → render categories → items. Tapping an
   item with variants/modifiers opens a picker; otherwise it's added directly to the cart.
4. **Build cart:** adjust quantities, add per-line and order-level notes; live subtotal.
5. **Place order:** `POST /api/v1/orders/` with a generated **`Idempotency-Key`** header.
6. **Confirmation:** show order id + status; optionally poll `GET /api/v1/orders/{id}/` for status
   updates. Offer "Start next table order".

---

## 5. Screens (v1)

| Screen | Purpose | Key elements |
|---|---|---|
| **Login** | Authenticate waiter | email, password, submit, error state |
| **Ordering** | Table + menu + cart in one workspace | mode badge, table picker, category tabs, menu list, cart panel, place button |
| **Item picker (modal)** | Choose variant/modifiers | required/optional groups, validation, add-to-cart |
| **Confirmation** | Acknowledge placed order | order id, status, "next order" |

---

## 6. API contracts (already exist in the backend)

All endpoints are served by **both** the local node (LAN, `http://{leader-ip}:3001`) and the
**cloud** — except **login, which is cloud-only**.

### Auth (cloud only)
```
POST /api/v1/auth/login/
Body:  { "email": "<email-or-username>", "password": "<password>" }
200:   { session token + restaurants[].locations[] context }
401:   { "error": "Invalid credentials" }
```
> Login requires internet. Cache the session/context so the app can keep ordering on the LAN after a
> successful login even if internet later drops.

### Menu
```
GET /{base}/api/v1/tables/{table_uuid}/menu/
200: { categories: [ { id, name, items: [ { id, name, base_price, station,
                        variants: [...], modifier_groups: [...] } ] } ] }
```

### Place order
```
POST /{base}/api/v1/orders/
Headers: Idempotency-Key: <uuid>
Body: {
  "table_uuid": "<uuid>",
  "source": "Waiter_App",
  "customer_note": "<string>",
  "items": [
    { "menu_item": "<id>", "variant": "<id|null>", "quantity": <int>,
      "notes": "<string>", "modifiers": ["<id>", ...] }
  ]
}
200: { id, status, total, ... }
```

### Order status / health
```
GET /{base}/api/v1/orders/{id}/   → { id, status, total, ... }
GET /{node}/health/               → 200 OK when leader node is reachable (LAN probe)
```

`{base}` = node URL in Local mode, cloud URL in Cloud mode. `{node}` = the leader node URL.

---

## 7. Dual-path networking (v1 behavior)

- **Leader address in v1:** a configured node base URL + cloud base URL (same approach as the
  current waiter page). **Dynamic mDNS discovery and failover-following are a fast-follow**, not v1
  — but isolate all "where is the leader?" logic behind one module so it can be swapped later.
- **Mode selection:** probe `/health/`; prefer Local, fall back to Cloud. Re-probe on a timer and
  before placing an order.
- **Idempotency:** always send `Idempotency-Key` so a retry across a mode switch can't double-create
  an order.

---

## 8. Architecture (keep it future-proof)

- **Single native codebase** with a **role abstraction** — v1 only implements `WAITER`, but routing
  and navigation are role-aware so `KIOSK` / `PRINTER_STATION` can be added as modes later (see
  `apps_and_configs.md` in the repo root).
- **Layers:**
  - `auth/` — login, session/token storage, restaurant-location context.
  - `net/` — `connection` (probe + mode), `apiClient` (base-url-aware fetch), `discovery` (stub now;
    mDNS later).
  - `ordering/` — menu fetch + render, cart state, place-order, confirmation.
  - `ui/` — screens & components.
- **Local cache:** session context + last menu/tables (read-only) so the ordering screen is usable
  the moment the app opens on the LAN.

---

## 9. Acceptance criteria (v1 "done")

1. Waiter logs in with valid credentials and lands on the ordering screen; invalid credentials show
   an error.
2. App correctly shows **Local** vs **Cloud** mode based on node `/health/` reachability.
3. Waiter selects a table and sees that table's menu (categories, items, variants, modifiers).
4. Waiter builds a multi-item cart with quantities + notes and sees a correct live total.
5. Placing an order succeeds in **both** Local and Cloud modes and returns an order id + status.
6. Re-submitting the same order (retry / mode switch) does **not** create a duplicate
   (`Idempotency-Key` honored).
7. Errors (network down, both paths unreachable, validation) surface clear messages; no silent
   failures.

---

## 10. Open questions / to confirm

- **Login response shape:** confirm the exact fields returned (token vs session cookie, role flag,
  location ids) so the client stores the right context. (Backend uses Django session auth +
  `StaffUser`; confirm how the mobile client should carry the session — token header vs cookie.)
- **`source` value:** the existing web page sends `source: "Staff_POS"`; confirm whether the mobile
  app should send `"Waiter_App"` or reuse `"Staff_POS"`.
- **Node base URL provisioning:** how does the app learn the node URL in v1 — manual setting, QR
  pairing, or cloud-provided? (Drives whether mDNS is needed sooner.)
- **Framework choice:** React Native vs Capacitor vs Flutter — pick before build (must support mDNS
  for the fast-follow).

---

## 11. Out of scope → later milestones

| Later | What |
|---|---|
| v1.1 | **mDNS leader discovery + failover-following** (replace static node URL) |
| v2 | Kiosk mode, Printer Station mode (follower print endpoint) |
| v2+ | Payments, order edit/history, table/floor management, KDS view, offline order queueing |
