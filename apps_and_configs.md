# Soboss POS — Apps & Configuration Plan

This document defines the full set of applications in the system, what each is for, what each
contains, and how they connect to the existing **leader–follower node** + **cloud server**
architecture.

---

## 0. Guiding principle: split apps on the *offline-LAN boundary*, not on login role

The single most important architectural decision: **group apps by where they run and whether they
need the offline LAN path — not by user role.**

- Some apps **must work offline** on the local Wi-Fi and talk directly to the **leader node**
  (waiter, kiosk, printer station). These need LAN discovery + offline order handling.
- Other apps are **cloud-only management consoles** (admin, super admin). They never touch the LAN
  and only need internet.

Bundling cloud-only admin screens into a heavy offline-capable native app — or forcing
offline-critical apps into a plain browser that can't do LAN discovery — makes both worse.
**Role-based views belong *inside* each app, not as the reason to merge apps.**

---

## 1. How many apps do we need?

**Four deliverables**, grouped into two families:

| # | App | Family | Runs on | Network path |
|---|------------------------------|----------------|----------------------------|----------------------------------|
| 1 | **Node app** (Electron)      | Infrastructure | Windows/Mac desktop/tablet | Is the leader/follower itself    |
| 2 | **Floor app** (native)       | Offline / LAN  | Android/iOS tablet         | LAN → leader node (offline-first)|
| 3 | **Management web app**       | Cloud          | Any browser                | Cloud only                       |
| 4 | **Cloud server** (backend)   | Cloud          | Server                     | Central hub / registry           |

> The **Floor app** is *one* native app with **modes** (Waiter / Kiosk / Printer Station) selected
> by login role or device configuration. The **Management web app** is *one* web app with
> **Admin** and **Super Admin** as permission tiers. So "many roles" → still only these apps.

---

## 2. What each app is for

### 1) Node app — Electron desktop (already exists)
The backbone. Each installed instance is a cluster **node** that becomes a **leader** or
**follower** (cloud assigns the role via heartbeat). The leader receives orders, fires KOTs,
drives the KDS, and **forwards print jobs** to followers. Followers print jobs routed to them.
- **Purpose:** run the local POS brain + printing + KDS, with automatic failover.
- **Status:** ✅ exists today (`main-node/`).

### 2) Floor app — native tablet app (NEW)
A single native app (Electron/Capacitor/Tauri or React Native) for **on-the-floor devices** that
must keep working when the internet is down. It has three modes:
- **Waiter mode** — take orders at the table, send directly to the leader node.
- **Kiosk mode** — self-service customer ordering (Android tablet).
- **Printer Station mode** — a tablet attached to a printer that acts as a lightweight
  **follower** print endpoint.
- **Purpose:** offline-first ordering + printing on the LAN, surviving leader failover.
- **Status:** ⚠️ today only a **browser** waiter page exists (`cloud-server/waiter_app/`), which
  cannot do LAN discovery. Needs to become native for true offline failover.

### 3) Management web app — Admin + Super Admin (NEW / cloud)
Cloud-only management console served by the backend, with role tiers:
- **Admin** — single-restaurant/location management: menu, tables, staff, printers, reports.
- **Super Admin** — cross-restaurant/tenant control: onboarding, billing, global config, all
  locations.
- **Purpose:** configuration and oversight. No LAN, no offline requirement.
- **Status:** ⚠️ to be built (the cloud server already exposes the data).

### 4) Cloud server — backend (already exists)
Django backend that is the **source of truth** and **registry/relay**:
- Stores menu/orders/config, assigns leader/follower roles, relays each node's `lan_host`/
  `lan_port` so nodes (and apps) can discover the leader.
- **Purpose:** central sync hub + node directory + cloud fallback for ordering.
- **Status:** ✅ exists today (`cloud-server/`).

---

## 3. What each app contains

### Node app (Electron)
- Local SQLite DB (`DB_PATH`), Fastify API on `0.0.0.0:3001`.
- Leader/follower role logic + cloud heartbeat (`heartbeatWorker`, `clusterService`).
- Order intake (`/api/v1/orders/`), KOT build, **print job queue + forwarding**
  (`printService`, `/api/v1/cluster/print-job`).
- KDS WebSocket, mDNS advertising of `_soboss._tcp` (leader only), printer drivers.

### Floor app (native tablet)
- **Leader discovery** (the key addition): mDNS browse for `_soboss._tcp` filtered by
  `cluster_role: leader` + cloud-cached fallback (see §4).
- **Dual-path ordering:** probe leader `/health/`; if up → order to node, else → cloud.
- Mode-specific UI: Waiter (table + cart), Kiosk (customer self-order), Printer Station
  (registers as follower: `/health/` + `/api/v1/cluster/print-job` + local printer driver).
- Local cache of menu/tables for offline use.

### Management web app
- Auth + **role-gated views** (Admin vs Super Admin).
- Admin: menu/category/item editor, table & printer config, **node management** (assign print
  routes / stations to nodes), staff, location reports.
- Super Admin: tenant/restaurant onboarding, billing, global settings, all-locations dashboard.
- Talks only to cloud REST APIs.

### Cloud server
- REST APIs (orders, menu, sync, heartbeat), Postgres, node registry with `lan_host`/`lan_port`,
  role assignment, cloud-fallback order path.

---

## 4. Admin app + web view — the recommended approach

**Recommendation: one cloud web app, role-gated — do NOT build separate Admin and Super Admin
apps, and do NOT make admin a native app.**

Why:
- Admin and Super Admin are **online-only management consoles** with no offline/LAN needs → a
  responsive **web app** is the right tool (instant updates, no install, any device).
- Super Admin is simply a **higher permission tier** of the same console, not a different product.

How to structure it:
1. **Single web codebase**, server-driven auth returning the user's role/permissions.
2. **Route + component gating by role:** Admin sees their location(s); Super Admin sees a tenant
   switcher + global screens. Same shell, conditional navigation.
3. **Permission checks enforced on the backend**, not just hidden in the UI.
4. **"Web view" inside a native app, if ever needed:** since admin is already a web app, any native
   shell can embed it in a WebView — but admins normally just open it in a browser. Keep the
   admin experience web-first; reserve native builds for the offline floor apps only.

### Decision summary

| Concern | Decision |
|---|---|
| Admin vs Super Admin | **One web app**, gated by role/permission tier |
| Admin native vs web | **Web** (cloud-only, no offline need) |
| Where role-based views live | **Inside** each app, never the reason to split apps |
| What gets a native build | **Only** offline-LAN apps (waiter / kiosk / printer station) |
| Leader discovery for floor apps | **mDNS** (native) + **cloud-cached IP** fallback |

---

## 5. How it all connects (one picture)

```
                         ┌─────────────────────────┐
                         │      CLOUD SERVER        │  source of truth + node registry
                         │  (Django, Postgres)      │  assigns leader/follower roles
                         └───────────▲───┬──────────┘
            heartbeat (lan_host/port)│   │ role + peer/leader addresses
                                     │   │                 ▲ cloud-only
        ┌────────────────────────────┴───┴──────────┐      │
        │                LOCAL Wi-Fi / LAN           │      │
        │                                            │  ┌───┴──────────────────┐
        │   ┌──────────────┐   forward print jobs    │  │  MANAGEMENT WEB APP   │
        │   │ LEADER node  │ ──────────────────────► │  │  Admin / Super Admin  │
        │   │  (Electron)  │   /api/v1/cluster/...   │  │  (browser, role-gated)│
        │   └──────▲───────┘                         │  └───────────────────────┘
        │  orders  │ /api/v1/orders/                 │
        │   ┌──────┴───────┐        ┌──────────────┐ │
        │   │  FLOOR APP   │        │ FOLLOWER node│ │
        │   │ waiter/kiosk │        │  +printer    │ │
        │   │  (native)    │        │ (Electron or │ │
        │   │  mDNS+cache  │        │  native PS)  │ │
        │   └──────────────┘        └──────────────┘ │
        └─────────────────────────────────────────────┘
```

- **Floor app** discovers and orders the **leader** directly (offline-first); falls back to cloud.
- **Leader** forwards print jobs to **follower / printer-station** devices on the LAN.
- **Management web app** and the cloud are the online control plane.
- The cloud relays addresses so everyone can find the current leader, even after failover.

---

## 6. Build order (suggested)

1. **Node app** — exists; harden LAN IP selection + firewall guidance.
2. **Floor app (native)** — start with Waiter mode + mDNS/cloud-cached leader discovery; add Kiosk
   and Printer Station modes.
3. **Management web app** — single role-gated console (Admin first, then Super Admin tier).
4. Keep the **cloud server** as the registry/fallback throughout.
