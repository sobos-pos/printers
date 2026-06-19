# Soboss Waiter — Mobile App (React Native / Expo)

Native waiter app for floor staff. **v1**: log in and place an order (table → menu → cart → submit)
against the **local leader node over the LAN**, with a **cloud fallback**. Leader discovery is via
**mDNS** (primary) with a manual **Settings** URL fallback.

Built with **Expo SDK 56** (dev client), **expo-router**, **React Query**, **zustand**,
**react-native-zeroconf**. See `../planning/PRD.md` for the product spec.

## Architecture (`src/`)

| Layer | Files | Responsibility |
|---|---|---|
| `lib/` | `types.ts`, `money.ts`, `storage.ts`, `config.ts` | Domain types, cents math (prices are decimal strings), persistence, constants |
| `net/` | `discovery.ts`, `connection.ts`, `apiClient.ts` | mDNS browse → probe `/health/` → Local/Cloud mode; base-URL-aware fetch (Bearer + Idempotency-Key) |
| `auth/` | `api.ts`, `store.ts` | Cloud-only login, secure token + context, `/auth/me` revalidate, location selection |
| `ordering/` | `api.ts`, `cart.ts`, `hooks.ts` | Tables (cloud + cache), menu (active base + cache), cart (cents), place-order (idempotent) |
| `ui/` | `theme.ts`, `components/*` | ModeBadge, TablePicker, CategoryTabs, MenuList, ItemPickerModal, CartPanel |
| `app/` | expo-router routes | `index` (gate), `login`, `ordering`, `settings`, `confirm` |

**Networking model:** the node serves `/health/`, menu, and orders; the **tables list is cloud-only**
so it's cached for Local-mode use. All `where-is-the-leader` logic is isolated in `net/` so mDNS can
evolve (e.g. failover-following) without touching screens.

## Prerequisites

- Node ≥ 20.19 (22.13+ recommended), an Expo account (`npx expo login`) for EAS builds.
- A running `cloud-server` (Django) for login, and a `main-node` on the same Wi-Fi for Local mode.

## Run (development)

mDNS uses a **native module**, so it does **not** work in Expo Go — you need a **dev client**, and it's
best tested on a **physical device on the same Wi-Fi as the node**.

```bash
npm install
# One-time: build & install a dev client on the device/emulator
npx eas build --profile development --platform android   # or: ios
# Then start the bundler and open the dev client
npx expo start --dev-client
```

On first launch, open **Settings** and set the **Cloud URL** (required for login) and, if mDNS can't
reach the node, the **Node URL** (e.g. `http://192.168.1.50:3001`).

## Build (release)

```bash
npx eas build --profile preview --platform android      # .apk for sideload testing
npx eas build --profile production --platform all        # store builds (.aab / .ipa)
```

## Quality gates

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # jest (money / cart / apiClient unit tests)
```

## Notes / known caveats

- **iOS Local Network permission** (`NSLocalNetworkUsageDescription` + `NSBonjourServices` for
  `_soboss._tcp`) is declared in `app.json`; the OS prompts on first mDNS use.
- **Android** needs `CHANGE_WIFI_MULTICAST_STATE` (declared) and a network that allows multicast.
- Prices are **decimal strings** end-to-end; all cart math is in integer cents (`lib/money.ts`).
- An **Idempotency-Key** is generated per cart and reused across retries / mode switches so a
  resubmit never double-creates an order.
</content>
