# Node Management — Updated v2

---

## Node Management Tab — Leader View

```
┌─────────────────────────────────────────────────────────────────────┐
│  NODE MANAGEMENT                                                      │
│                                                                       │
│  ┌────── Print Routing ─────────────────────────────────────────────┐ │
│  │                                                                    │ │
│  │  Assign stations to nodes for print routing.                       │ │
│  │                                                                    │ │
│  │  Station   │ Type │ Assigned Node                 │ Status         │ │
│  │  ─────────────────────────────────────────────────────────────    │ │
│  │  Kitchen   │ KOT  │ [▾ Printer-1 (node-a1b2)   ] │ 🟢 Online     │ │
│  │  Kitchen   │ Bill │ [▾ Billing (node-c3d4)      ] │ 🟢 Online     │ │
│  │  Bar       │ KOT  │ [▾ Bar-Printer (node-e5f6)  ] │ 🟢 Online     │ │
│  │  Bar       │ Bill │ [▾ — Unassigned —            ] │ ⚫ —          │ │
│  │                                                                    │ │
│  │  Dropdown options for each row:                                    │ │
│  │    — Unassigned — (Leader prints locally)                          │ │
│  │    Printer-1 (node-a1b2) 🟢                                       │ │
│  │    Billing (node-c3d4) 🟢                                         │ │
│  │    Bar-Printer (node-e5f6) 🟢                                     │ │
│  │    Old-Kitchen (node-x1y2) 🔴                                     │ │
│  │                                                                    │ │
│  │  [Save Assignments]                                                │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌────── Nodes ─────────────────────────────────────────────────────┐ │
│  │                                                                    │ │
│  │  Node Name    │ Node ID        │ Role      │ Status               │ │
│  │  ─────────────────────────────────────────────────────────────    │ │
│  │  Main-Server  │ node-f7a2      │ Leader    │ 🟢 Online            │ │
│  │  Printer-1    │ node-a1b2      │ Follower  │ 🟢 Online            │ │
│  │  Billing      │ node-c3d4      │ Follower  │ 🟢 Online            │ │
│  │  Bar-Printer  │ node-e5f6      │ Follower  │ 🟢 Online            │ │
│  │  Old-Kitchen  │ node-x1y2      │ Follower  │ 🔴 Offline           │ │
│  │                                                                    │ │
│  │  ── Add Node ──                                                    │ │
│  │  Node Name: [________________]   [Add Node]                        │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Adding a Node

```
Manager types "Bar-Printer" → clicks [Add Node]

→ POST /api/v1/sync/nodes/create/
  Body: { "node_name": "Bar-Printer" }

→ Cloud creates:
  LocationNode(
    node_id     = "node-e5f6a7b8"    ← auto-generated
    node_name   = "Bar-Printer"
    cluster_role = "follower"
    is_online   = false               ← starts offline
    api_key_hash = ""                 ← no key yet, created at login
  )

→ Response: { node_id: "node-e5f6a7b8", node_name: "Bar-Printer", status: "offline" }

→ Node appears in the table immediately as 🔴 Offline
→ Node appears in Print Routing dropdowns (selectable even while offline)
```

**No pairing code. No registration dance.** The node exists in Cloud as a record. It comes alive when someone logs in on a physical machine and picks it.

### How an Offline Node Comes Online

```
New machine → launch Electron app → Setup Wizard

Step 1: Manager Login
  Email: manager@biryani.com
  Password: ••••••••
  → POST /api/v1/auth/login/
  → Response: { session_token, restaurants, locations }

Step 2: Select Location → "Koramangala"
  → App fetches nodes for this location
  → Shows ONLY offline nodes:

  ┌──────────────────────────────────────────┐
  │  Select a node to connect:                │
  │                                            │
  │  Bar-Printer (node-e5f6)     🔴 Offline   │
  │  [Connect]                                 │
  │                                            │
  │  Old-Kitchen (node-x1y2)     🔴 Offline   │
  │  [Connect]                                 │
  │                                            │
  │  (Online nodes hidden — already running)   │
  └──────────────────────────────────────────┘

Step 3: Click [Connect] on "Bar-Printer"
  → POST /api/v1/auth/reconnect-node/
    Body: { node_id: "node-e5f6" }
  → Cloud re-issues API key, responds with:
    { node_id, api_key: "sk_live_...", node_name, cluster_role: "follower", location }
  → App saves to SQLite: node_id, api_key, node_name, role=follower
  → Starts heartbeat worker → Cloud marks node online
  → Node appears 🟢 in Leader's Node Management tab
```

### Assigning Stations to Nodes

```
Manager opens Leader → Node Management → Print Routing section:

  Kitchen │ KOT  │ [▾ — Unassigned — ]         ← change to Printer-1
  Kitchen │ Bill │ [▾ — Unassigned — ]         ← change to Billing
  Bar     │ KOT  │ [▾ — Unassigned — ]         ← change to Bar-Printer
  Bar     │ Bill │ [▾ — Unassigned — ]         ← leave unassigned

Clicks [Save Assignments]
  → POST /api/v1/sync/label-assignments/
  → Cloud persists mapping
  → Leader caches in local SQLite label_assignments table
  → Print routing now active
```

---

## Print Routing Resolution

```
ORDER: { items: [Pizza (KITCHEN), Mojito (BAR)] }

Step 1: Split by station
  KITCHEN → [Pizza]
  BAR     → [Mojito]

Step 2: For each station, create 2 jobs
  KITCHEN-KOT → lookup label_assignments(KITCHEN, KOT) → node-a1b2 → forward
  KITCHEN-Bill → lookup label_assignments(KITCHEN, Bill) → node-c3d4 → forward
  BAR-KOT     → lookup label_assignments(BAR, KOT)     → node-e5f6 → forward
  BAR-Bill    → lookup label_assignments(BAR, Bill)     → NULL      → print locally

Step 3: Forward or print locally
  node-a1b2 ONLINE?  → POST http://192.168.1.20:3001/api/v1/cluster/print-job
  node-c3d4 ONLINE?  → POST http://192.168.1.30:3001/api/v1/cluster/print-job
  node-e5f6 ONLINE?  → POST http://192.168.1.40:3001/api/v1/cluster/print-job
  NULL (unassigned)   → Leader's own printer

Step 4: If forwarding fails (node offline, 3 retries exhausted)
  → Fallback to Leader's local printer
```

---

## Cloud Data Model

```python
# EXISTING — no change
class PrinterStation(BaseModel):
    location = FK → Location
    name     = "Kitchen"
    code     = "KITCHEN"

# MODIFIED
class LocationNode(BaseModel):
    location       = FK → Location
    node_id        = "node-a1b2c3d4"          # auto-generated
    node_name      = "Printer-1"              # human name (was node_label)
    cluster_role   = "follower"               # leader | follower
    lan_host       = "192.168.1.20"
    lan_port       = 3001
    api_key_hash   = "..."                    # empty until machine connects
    is_online      = False
    last_heartbeat = None
    # REMOVED: station_codes, election_priority, promotion_pending

# NEW
class StationNodeAssignment(BaseModel):
    location     = FK → Location
    station_code = "KITCHEN"                  # FK-like to PrinterStation.code
    print_type   = "KOT"                     # "KOT" | "Bill"
    assigned_node = FK → LocationNode (null)  # NULL = Leader fallback

    class Meta:
        unique_together = ['location', 'station_code', 'print_type']
```

---

## Cloud Endpoints

```
POST /api/v1/sync/nodes/create/
  Auth: Bearer tok_... (manager session)
  Request:  { "node_name": "Bar-Printer" }
  Response: {
    "node_id": "node-e5f6a7b8",
    "node_name": "Bar-Printer",
    "cluster_role": "follower",
    "is_online": false
  }

GET /api/v1/sync/label-assignments/
  Auth: Api-Key sk_live_...
  Response: {
    "assignments": [
      { "station_code": "KITCHEN", "station_name": "Kitchen",
        "print_type": "KOT", "assigned_node_id": "node-a1b2",
        "assigned_node_name": "Printer-1", "node_online": true },
      { "station_code": "KITCHEN", "station_name": "Kitchen",
        "print_type": "Bill", "assigned_node_id": "node-c3d4",
        "assigned_node_name": "Billing", "node_online": true },
      { "station_code": "BAR", "station_name": "Bar",
        "print_type": "KOT", "assigned_node_id": null,
        "assigned_node_name": null, "node_online": null },
      { "station_code": "BAR", "station_name": "Bar",
        "print_type": "Bill", "assigned_node_id": null,
        "assigned_node_name": null, "node_online": null }
    ]
  }
  Note: Returns ONE row per (station × print_type).
        If station has 2 types, that's 2 rows.
        Rows auto-generated from PrinterStation list.

POST /api/v1/sync/label-assignments/
  Auth: Bearer tok_... (manager session)
  Request: {
    "assignments": [
      { "station_code": "KITCHEN", "print_type": "KOT", "assigned_node_id": "node-a1b2" },
      { "station_code": "KITCHEN", "print_type": "Bill", "assigned_node_id": "node-c3d4" },
      { "station_code": "BAR",     "print_type": "KOT", "assigned_node_id": "node-e5f6" },
      { "station_code": "BAR",     "print_type": "Bill", "assigned_node_id": null }
    ]
  }
  Response: { "saved": 4 }
```

---

## Follower View — "Nodes" Tab

Followers see a read-only summary:

```
┌─────────────────────────────────────────────────────────────┐
│  CLUSTER STATUS                                               │
│                                                               │
│  ┌────── This Node ─────────────────────────────────────────┐ │
│  │  Node Name: Bar-Printer                                    │ │
│  │  Node ID:   node-e5f6                                      │ │
│  │  Role:      Follower                                       │ │
│  │  Status:    🟢 Online                                      │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌────── Leader ────────────────────────────────────────────┐ │
│  │  Node Name: Main-Server                                    │ │
│  │  Address:   192.168.1.10:3001                              │ │
│  │  Status:    🟢 Online                                      │ │
│  └──────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Full Lifecycle Summary

```
1. Manager creates stations via Cloud admin/API
     PrinterStation: Kitchen (KITCHEN), Bar (BAR)

2. Manager opens Leader → Node Management → Nodes section
     Types "Printer-1" → [Add Node] → Cloud creates offline follower
     Types "Billing"   → [Add Node] → Cloud creates offline follower
     Types "Bar-Printer" → [Add Node] → Cloud creates offline follower

3. Manager opens Leader → Node Management → Print Routing
     Kitchen │ KOT  │ [Printer-1]
     Kitchen │ Bill │ [Billing]
     Bar     │ KOT  │ [Bar-Printer]
     Bar     │ Bill │ [— Unassigned —]
     → [Save Assignments]

4. Staff takes new machine → launches Electron → Setup Wizard
     Logs in → selects location → sees offline nodes only
     Picks "Printer-1" → [Connect] → machine comes online as follower
     (Repeat for each physical machine)

5. Order arrives → Leader routes:
     KITCHEN items → KOT to Printer-1, Bill to Billing
     BAR items     → KOT to Bar-Printer, Bill locally (unassigned)
```
