# How Owlbear Rodeo extensions work

A generic guide to the Owlbear Rodeo (OBR) extension platform, for SDK `@owlbear-rodeo/sdk` v3.1.0.
This document does not describe the code of this repository.

## How to read this document

Each claim has a source. The confidence marks are:

- **[SDK]**: confirmed in the SDK source. Paths are relative to
  `node_modules/@owlbear-rodeo/sdk/lib/` (v3.1.0, the same as `src/` in
  https://github.com/owlbear-rodeo/sdk).
- **[DOC]**: stated in the official docs at `https://docs.owlbear.rodeo/extensions/...`.
- **[STAFF]**: stated by OBR staff in SDK issue #9 (https://github.com/owlbear-rodeo/sdk/issues/9),
  which quotes OBR developer mitchemmc from Discord.
- **[COMMUNITY]**: a consistent pattern in published extensions. The extension repos are named inline.
- **[UNVERIFIED]**: nobody has confirmed it from the source or the docs. The OBR host page and server are
  closed source, so the SDK only shows the client side. Each [UNVERIFIED] item tells you how to test it
  in a dev room.

## Contents

1. [Architecture](#1-architecture)
2. [Manifest](#2-manifest)
3. [Lifecycle](#3-lifecycle)
4. [Request/response protocol](#4-requestresponse-protocol)
5. [Storage options](#5-storage-options)
6. [Merge and event semantics](#6-merge-and-event-semantics)
7. [Permissions and trust model](#7-permissions-and-trust-model)
8. [Broadcast](#8-broadcast)
9. [Context menus](#9-context-menus)
10. [Action API](#10-action-api)
11. [Popovers, modals and notifications](#11-popovers-modals-and-notifications)
12. [Theme](#12-theme)
13. [Player and party APIs](#13-player-and-party-apis)
14. [Scene items](#14-scene-items)
15. [Known SDK bugs and quirks](#15-known-sdk-bugs-and-quirks)
16. [Security](#16-security)
17. [Best practices for state sync](#17-best-practices-for-state-sync)
18. [Open questions and how to test them](#18-open-questions-and-how-to-test-them)

---

## 1. Architecture

### 1.1 Host and iframes

OBR is a web page (the **host**). An extension is a web site that the host loads in one or more
**iframes**. The extension never touches the OBR page directly. It sends messages to the host, and the
host does the work. The SDK is a thin client for this message channel. It has no state of its own except
listeners and context menu callbacks. [SDK: `index.js`, `messages/MessageBus.js`]

Each iframe is an **isolated JavaScript context**. Each iframe loads its own copy of the SDK, has its own
`MessageBus`, its own listeners and its own memory. An extension can have these iframes at one time:

| Surface | How it opens | Lifetime |
|---|---|---|
| Action popover | Manifest `action.popover`. The user clicks the extension icon at the top left. | Community evidence says the host loads it with the room and keeps it loaded while the popover is closed (Bubbles opens its own action from a broadcast listener in `action/main.tsx`). [COMMUNITY] |
| Background page | Manifest `background_url`. A hidden iframe. | Published extensions rely on it staying loaded for the whole time the room is open. [COMMUNITY: see 9.2] The manifest docs say only "an optional url to load as a background script". [UNVERIFIED: lifetime] |
| Popover | `OBR.popover.open({ id, url, ... })` | A new iframe each time it opens. Gone after `close`. [UNVERIFIED] |
| Modal | `OBR.modal.open({ id, url, ... })` | A new iframe each time it opens. Gone after `close`. [UNVERIFIED] |
| Context menu embed | `contextMenu.create({ embed: { url, height } })` | Exists while the context menu is shown. |

Important consequences:

- Every **client** (each browser tab of each player and GM) loads its own set of iframes. A room with
  one GM and four players runs your background code five times. All five get the same change events.
- Iframes cannot call each other through the SDK. To talk between your own iframes, use shared state
  (metadata plus change events), `OBR.broadcast.sendMessage(..., { destination: "LOCAL" })`, or browser
  APIs such as `BroadcastChannel` or `storage` events (the iframes share one origin). [COMMUNITY:
  Pretty Sordid Initiative, owlbear-rodeo/dice, GM's Grimoire]
- A popover or modal must load its own state when it opens. It does not inherit memory from the iframe
  that opened it.

### 1.2 Transport: `postMessage` and the `obrref` parameter

When the SDK module loads, `getDetails()` reads the URL query parameter **`obrref`**. The value is
base64 of `"<hostOrigin> <roomId>"`. [SDK: `common/getDetails.js`]

- `OBR.isAvailable` is `Boolean(hostOrigin)`. It is `false` when the page is not embedded by OBR (for
  example when you open `localhost:5173` directly). [SDK: `index.js`]
- `OBR.room.id` comes from the URL. It works before the SDK is ready. [SDK: `api/RoomApi.js`]
- Outgoing messages: `window.parent.postMessage({ id, data, ref, nonce }, hostOrigin)`. [SDK:
  `messages/MessageBus.js`]
- Incoming messages are accepted only if `event.origin === hostOrigin` and `message.id` is a string.
  All other messages are ignored. [SDK: `messages/MessageBus.js`, `messages/Message.js`]
- Data crosses the boundary with the structured clone algorithm (that is how `postMessage` works). The
  host then sends it over the network. Keep all values JSON-safe: plain objects, arrays, strings,
  numbers, booleans and `null`. Do not store `Date`, `Map`, `Set`, class instances or functions.

The host sends `OBR_READY` with `{ ref, userId }` when the iframe is connected. Until then the SDK has no
`ref` and cannot send. [SDK: `messages/MessageBus.js`]

---

## 2. Manifest

The manifest is a JSON file at a public URL. The user installs the extension with that URL.
[DOC: reference/manifest]

```json
{
  "name": "My Extension",
  "version": "1.0.0",
  "manifest_version": 1,
  "description": "Short description",
  "author": "Name",
  "homepage_url": "https://example.com",
  "icon": "/icon.svg",
  "action": {
    "title": "My Extension",
    "icon": "/icon.svg",
    "popover": "/",
    "width": 300,
    "height": 400
  },
  "background_url": "/background.html",
  "permissions": [{ "name": "clipboard-write", "reason": "Copy results" }]
}
```

| Field | Notes |
|---|---|
| `name` | Max 45 characters. |
| `version`, `manifest_version` | `manifest_version` is `1`. |
| `description` | Max 128 characters. |
| `icon`, `author`, `homepage_url` | Optional. |
| `action` | `{ title, icon, popover, width?, height? }`. `width` and `height` are the **maximum** popover size. Change the real size at run time with `OBR.action.setHeight/setWidth`. |
| `background_url` | Optional. A page that the host loads as a hidden iframe. |
| `permissions` | Browser features for the iframe `allow` attribute: `clipboard-write`, `clipboard-read`, `autoplay`, `bluetooth`, `camera`, `microphone`, `usb`, `display-capture`, `hid`. These are **not** OBR data permissions. They apply to all iframes of the extension. |

Hosting: OBR makes "safe" requests for the manifest and icons, so CORS is usually not needed. If you
need it, allow `https://www.owlbear.rodeo`. [DOC: tutorial-sharing-your-extension/hosting-your-extension]

---

## 3. Lifecycle

### 3.1 SDK readiness: `OBR.onReady`, `OBR.isReady`, `OBR.isAvailable`

```ts
// index.js (simplified)
onReady(cb) { messageBus.ready ? cb() : messageBus.once("OBR_READY", () => cb()); }
get isReady() { return messageBus.ready; }
isAvailable: Boolean(details.origin)
```
[SDK: `index.js`]

- `OBR.onReady(cb)` calls `cb` at once (synchronously) if the SDK is already ready. Otherwise it calls
  `cb` one time when `OBR_READY` arrives.
- There is no "not ready again" event. Readiness is set once per iframe load.

### 3.2 Calls before ready

`MessageBus.send` throws `Error("Unable to send message: not ready")` if `ref` is not set.
[SDK: `messages/MessageBus.js`] The effect depends on the method type:

| Method type | Examples | Before ready |
|---|---|---|
| Async methods | `getMetadata`, `setMetadata`, `getItems`, `action.setHeight` | Return a **rejected promise**. |
| Subscribe methods | `onMetadataChange`, `onChange`, `onReadyChange`, `broadcast.onMessage`, `theme.onChange` | **Throw synchronously**. No listener is registered. A React `useEffect` that does this crashes the render. |
| `OBR.player.id` getter | | Throws `"Unable to get user ID: not ready"`. |
| `OBR.room.id` getter | | Works. It reads the URL. |

Use a gate. The official sample uses this component
(https://github.com/owlbear-rodeo/initiative-tracker, `src/PluginGate.tsx`):

```tsx
export function PluginGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (OBR.isAvailable) OBR.onReady(() => setReady(true));
  }, []);
  return ready ? <>{children}</> : null;
}
```

In a background page, wrap all start-up code in `OBR.onReady(...)`, or `await new Promise(r =>
OBR.onReady(r))`. [COMMUNITY: owlbear-rodeo/dynamic-fog, owlbear-rodeo/weather `background/main.ts`]

### 3.3 Scene readiness

A room can have **no scene open**. The GM can also switch scenes at any time. The extension
verification guidelines require that an extension works "with a Scene open and no Scene open".
[DOC: tutorial-sharing-your-extension/extension-verification]

- `OBR.scene.isReady()` returns `true` if a scene is open and ready. [DOC: apis/scene; SDK:
  `api/scene/SceneApi.js`]
- `OBR.scene.onReadyChange(cb)` calls `cb(ready)` when the state changes. It does **not** call `cb`
  with the current value when you subscribe. Call `isReady()` first.
- A scene switch shows as `onReadyChange(false)` and then `onReadyChange(true)`. [COMMUNITY: the
  dynamic-fog and weather Reconciler delete their local items on `false` and rebuild from `getItems()`
  on `true`.]
- The iframe stays loaded across scene switches. Your in-memory state from the old scene is still there.
  You must reset it.
- Scene metadata and scene items belong to the scene. After a switch they are different data.
  Re-read both on every `onReadyChange(true)`. [UNVERIFIED: whether `scene.onMetadataChange` and
  `scene.items.onChange` also fire with the new scene's data on a switch. Do not depend on it.]
- Calls to `OBR.scene.*` with no scene open: the docs do not say what happens. The host either rejects
  the promise or does not reply, and the SDK rejects after 5 s. [UNVERIFIED] Do not call scene APIs
  until `isReady()` is `true`. Test in a dev room by closing the scene and calling
  `OBR.scene.getMetadata()` from the console of your iframe.
- The verification guidelines say "the Scene API is only used to store data that shares the Scene
  lifecycle". Data that must survive a scene switch belongs in room metadata.
  [DOC: extension-verification]

Official pattern (https://github.com/owlbear-rodeo/initiative-tracker `src/App.tsx`):

```tsx
useEffect(() => {
  OBR.scene.isReady().then(setSceneReady);
  return OBR.scene.onReadyChange(setSceneReady);
}, []);
```

### 3.4 The double-setup pitfall

`isReady()` and `onReadyChange(true)` can both report "ready" for the same scene load. If both start
setup (subscribe to items, read metadata, write defaults), setup runs twice. The first set of
subscriptions is then orphaned and keeps firing. React StrictMode in development also mounts each
effect twice. [COMMUNITY: GM's Grimoire `src/background/party.ts`; owlbear-rodeo/ranges
`src/background/syncSettings.ts`]

Fixes used by published extensions:

- Keep one "scene session" object. Before setup, tear down the previous session (call every stored
  unsubscribe function).
- Serialize setup and teardown through one promise queue, so that two triggers cannot overlap.
- Use a `syncing` or `listenersSet` flag.

```ts
let teardown: (() => void) | null = null;
let queue = Promise.resolve();

function onSceneReady(ready: boolean) {
  queue = queue.then(async () => {
    teardown?.();
    teardown = null;
    if (!ready) return;
    const unsubs = [
      OBR.scene.onMetadataChange(handleMetadata),
      OBR.scene.items.onChange(handleItems),
    ];
    handleMetadata(await OBR.scene.getMetadata());
    handleItems(await OBR.scene.items.getItems());
    teardown = () => unsubs.forEach((u) => u());
  }).catch(console.error);
}

OBR.onReady(() => {
  OBR.scene.onReadyChange(onSceneReady);
  OBR.scene.isReady().then(onSceneReady);
});
```

### 3.5 Room changes and reloads

The SDK reads the room ID once from the URL. A different room means a new page load of the iframe.
[SDK: `common/getDetails.js`] A page reload clears all iframe memory and all player metadata
(see section 5).

### 3.6 Role changes

The GM can change a player's role during a session. Read the role with `OBR.player.getRole()` and then
follow `OBR.player.onChange`. Re-run role-specific setup when the role changes.
[COMMUNITY: owlbear-rodeo/initiative-tracker, owlbear-rodeo/ranges]

---

## 4. Request/response protocol

Every async API call uses `sendAsync(id, data, timeout = 5000)`. [SDK: `messages/MessageBus.js`]

1. The SDK makes a nonce `_<uuid>` and posts `{ id, data, ref, nonce }` to the host.
2. It waits for `<id>_RESPONSE<nonce>` (resolve) or `<id>_ERROR<nonce>` (reject).
3. It races this against a timer.

### 4.1 Timeouts

- The default timeout is **5000 ms**. On timeout the promise rejects with
  `Error("Message <ID> took longer than 5000ms to get a result")`.
- Only the asset pickers (`OBR.assets.downloadImages`, `downloadScenes`) have no timeout (`-1`), because
  they wait for the user. [SDK: `api/AssetsApi.js`]
- A timeout does **not** cancel the operation on the host. A write that timed out can still be applied
  later. Do not treat a timeout as "not written".
- On timeout, the SDK does not remove the response listeners. A late response is ignored. This is a
  small leak. [SDK: `messages/MessageBus.js`]

### 4.2 Error shapes

- Host errors reject with **the payload that the host sent**, not with an `Error` object. The SDK does
  not wrap it.
- The observed shape of host errors is `{ error: { name: string, message?: string } }`.
  The rate limit error has `name === "RateLimitHit"` and the text "Too many requests".
  [COMMUNITY: GM's Grimoire `src/helper/obrHelper.ts`; obr-suite `docs/SDK-RATE-RECOVERY289.md`]
  [UNVERIFIED for other error kinds: the SDK does not define the shape.]
- Timeouts and "not ready" are plain `Error` objects.

Handle both shapes:

```ts
function isRateLimit(e: unknown): boolean {
  return typeof e === "object" && e !== null &&
    (e as any).error?.name === "RateLimitHit";
}
```

### 4.3 Rate limits

OBR has a rate limit for network operations. The numbers are not published. [UNVERIFIED]

- Community reports say the limit counts messages, not bytes, and that it applies to broadcasts and to
  item updates. After one rejected burst, later sends can also fail for a short time.
  [COMMUNITY: obr-suite `extensions/three-dragon-ante/src/game/broadcast.ts`; GM's Grimoire chunks
  token updates]
- Mitigations used: one serial send queue, about 150 ms between sends, exponential backoff
  (600 ms up to 6 s) after `RateLimitHit`, batch many item changes into one `updateItems` call. These
  numbers are community choices, not official limits.

### 4.4 Fire-and-forget is a trap

Many extensions call `setMetadata` without `await` or `.catch`. A failed write then only appears as an
unhandled rejection in the console. The user sees nothing. Always await writes, catch errors, and show a
notification (`OBR.notification.show(msg, "ERROR")`) when a write fails.

---

## 5. Storage options

### 5.1 Overview

| Store | API | Scope | Size limit | Persistence | Who receives changes | OBR undo stack |
|---|---|---|---|---|---|---|
| Room metadata | `OBR.room.getMetadata / setMetadata / onMetadataChange` | One room. All scenes. | **16 kB total for all extensions in the room** [DOC: apis/room] | Saved with the room | All clients in the room | No [STAFF] |
| Scene metadata | `OBR.scene.getMetadata / setMetadata / onMetadataChange` | One scene | **64 kB per update**. Counts against the room owner's storage quota. [STAFF] No limit in the docs. | Saved with the scene | All clients while that scene is open | **Yes. Ctrl+Z can undo it.** [STAFF] |
| Item metadata | `item.metadata` through `OBR.scene.items.updateItems` | One item in one scene | 64 kB per update [STAFF] | Saved with the item. **Deleted with the item.** | All clients (as `items.onChange`) | Yes. Item changes are in the scene history. [STAFF] |
| Player metadata | `OBR.player.getMetadata / setMetadata`; others read `Player.metadata` from `OBR.party` | One connection | 64 kB per update [STAFF] | **Per connection. A page reload resets it.** [STAFF] | Others through `party.onChange`; self through `player.onChange` | No [STAFF] |
| Local items | `OBR.scene.local.*` | This client only | Not documented | Not saved. Gone when the scene closes or the page reloads. [UNVERIFIED for scene close] | This client only | Not documented. Assume no. [UNVERIFIED] |
| Tool metadata | `OBR.tool.getMetadata(id) / setMetadata(id, update)` | One tool | Not documented | Not documented | Not documented | Not documented |
| Broadcast | `OBR.broadcast.sendMessage / onMessage` | Messages, not state | **16 kB per message** [DOC: apis/broadcast] | **Not saved.** Late joiners never see it. | Depends on `destination` (section 8) | No |
| `localStorage` | Browser | This browser, this extension origin | Browser limit (about 5 MB) | Per browser | Your own iframes on this browser (`storage` event) | No |

Notes:

- **Networking** [STAFF]: scene and item metadata use a CRDT and are "network resilient". Player metadata
  is a simple CRDT with only one writer. Room metadata has **no network resilience: last writer wins**.
  Staff say room metadata "is generally meant for small values with very low frequency updates".
- **16 kB room budget is shared.** Other extensions in the same room use the same 16 kB. Keep your room
  data small (settings only). [DOC: apis/room]
- **Over the limit:** no public source says what happens when a write is too large. The host probably
  rejects the promise. It may also fail silently. [UNVERIFIED] Test it in a dev room: write a 70 kB
  value to scene metadata, await the promise, then reload and read it back.
- **localStorage** can be empty. The verification guidelines require that the extension works in private
  browsing and with cookies disabled. Use localStorage only for per-user convenience data.
  [DOC: extension-verification]

### 5.2 How to choose

| Data | Good place |
|---|---|
| Per-token values (HP, initiative count) | Item metadata. It is deleted with the token, so no cleanup is needed. [COMMUNITY: official initiative tracker] |
| Encounter or map state that is not tied to one token | Scene metadata |
| Settings that persist across scenes | Room metadata (small) |
| "What I am doing now" for one player (current dice roll) | Player metadata [COMMUNITY: owlbear-rodeo/dice] |
| Visual helpers only one user sees (highlights, previews) | Local items |
| Events ("round changed", "your turn") | Broadcast, with the real state in metadata |
| Per-user preferences | localStorage, with a default when it is empty |

### 5.3 Undo stack interaction

Scene metadata writes and item changes go on the **writer's** OBR undo stack. [STAFF] So:

- A user who presses Ctrl+Z in OBR can revert your extension's last scene metadata write. Your
  extension gets a normal `onMetadataChange` with the old value. It cannot tell that this was an undo.
- If your extension has its own undo history, OBR undo can put the two histories out of step.
  No published extension has a proven fix. Treat every incoming value as authoritative and keep your
  own history defensive.
- Ctrl+Z pressed while focus is inside your iframe does **not** reach OBR. To support it, forward it:
  `OBR.scene.history.undo()` / `redo()`. [COMMUNITY: owlbear-rodeo/outliner `src/Outliner.tsx`]
- `OBR.scene.history` has `undo`, `redo`, `canUndo`, `canRedo`. [DOC: apis/scene/history]
- Room metadata and player metadata writes are not on the undo stack. [STAFF]

---

## 6. Merge and event semantics

### 6.1 `setMetadata` is a shallow top-level merge

The SDK sends `{ update }` to the host unchanged. The host merges. [SDK: `api/RoomApi.js`,
`api/scene/SceneApi.js`, `api/PlayerApi.js`] The docs say the values "will be spread among the current
metadata to avoid overriding other values". [DOC: apis/room, apis/scene, apis/player]

The effect is `{ ...current, ...update }`:

```ts
// current: { "a.ext/x": { n: 1, m: 2 }, "b.ext/y": 5 }
await OBR.scene.setMetadata({ "a.ext/x": { n: 9 } });
// result:  { "a.ext/x": { n: 9 },        "b.ext/y": 5 }   <- m is gone
```

- Each top-level key that you write is **replaced as a whole**. There is no deep merge.
- Other top-level keys (also other extensions' keys) are kept.
- **Delete a key** by writing `undefined`: `setMetadata({ [key]: undefined })`. The official dice
  extension does this (`owlbear-rodeo/dice` `src/plugin/DiceRollSync.tsx`). `postMessage` keeps
  `undefined`, and JSON on the network drops it. [COMMUNITY] [UNVERIFIED on the host side: test by
  deleting a key, reloading the page, and checking `key in metadata`.]
- To delete a key from **item** metadata, use `delete item.metadata[key]` inside the `updateItems`
  recipe. [DOC: tutorial-initiative-tracker]
- Type quirk: `SceneApi.d.ts` declares `setMetadata(update: Metadata)`; room, player and tool declare
  `Partial<Metadata>`. Runtime behaviour is the same. [SDK]
- Prefix every key with a reverse-domain ID, for example `com.example.my-ext/state`. All extensions
  share one metadata object. [DOC: reference/metadata]

### 6.2 No compare-and-swap

The SDK has no versioned write, no compare-and-set, no lock and no transaction. [SDK: whole API surface]

- Two clients that write the same top-level key at about the same time: **the last write wins** for that
  whole key.
- A read-modify-write (`getMetadata`, change, `setMetadata`) is a race. Two clients that do it at the
  same time lose one update.
- When `setMetadata` resolves, the host accepted the write. It does not prove that other clients have it.

### 6.3 Change events

All `onX` subscribe methods work the same way [SDK: `api/*.js`]:

1. They send `..._SUBSCRIBE` to the host and add a local listener.
2. They return an unsubscribe function. It sends `..._UNSUBSCRIBE` and removes the local listener.

Rules:

- **No initial value.** The callback does not run when you subscribe. Always call the matching `getX()`
  as well.
- **Full state, not a diff.** `onMetadataChange` passes the whole metadata object (all extensions' keys).
  `items.onChange` passes **every item in the scene**. A deleted item is visible only as a missing entry.
  There is no separate delete event. [DOC: apis/scene/items; SDK]
- **Your own writes echo back.** The change event also fires in the client that wrote. Published
  extensions depend on this: Pretty Sordid Initiative renders its order only from
  `scene.onMetadataChange` after its own `setMetadata`. [COMMUNITY: `src/classicInitiative/sceneOrder.ts`]
  Make handlers idempotent, so that an echo of your own write does nothing.
- **Order is not defined.** The SDK does not show whether the change event arrives before or after the
  `setMetadata` promise resolves. Do not depend on either order. [UNVERIFIED]
- **Filter by your key.** Other extensions' writes also fire your `onMetadataChange`. Compare your value
  with the last value you handled (for example by a revision number) and return early if nothing
  changed.

---

## 7. Permissions and trust model

### 7.1 What OBR enforces

- **Item permissions.** The room has per-layer permissions:
  `{MAP, PROP, MOUNT, CHARACTER, ATTACHMENT, NOTE, DRAWING, RULER, POINTER, TEXT, FOG}_{CREATE, UPDATE, DELETE}`
  plus `CHARACTER_OWNER_ONLY`. The GM sets them in the Player Permissions dialog.
  [DOC: reference/permission, /docs/permissions] The OBR app checks them for item writes. For example,
  FOG items are GM-writable only. [COMMUNITY: obr-suite `CHANGELOG.md`] [UNVERIFIED: whether the server
  or only the host page checks them.]
- `OBR.room.getPermissions()` and `onPermissionsChange` read the list. [DOC: apis/room]
- `OBR.player.hasPermission(p)` returns `true` for **any GM** without a check. For a player it looks
  for `p` in the room permission list. [SDK: `api/PlayerApi.js`]

### 7.2 What OBR does not enforce

- **No permission covers metadata.** The permission enum has nothing for room or scene metadata.
  [DOC: reference/permission]
- **Players can write room metadata.** [COMMUNITY: obr-suite Three-Dragon-Ante lets any player create
  a table with `OBR.room.setMetadata`.]
- **Players and scene metadata: conflicting reports.** One obr-suite comment says only the GM can write
  scene metadata (`src/modules/bubbles/index.ts`). Pretty Sordid Initiative writes scene metadata from
  code that players can run. No official source confirms either way. [UNVERIFIED] Test it: join a dev
  room as a player, call `await OBR.scene.setMetadata({ "test/x": 1 })` from the console of your
  iframe, and watch for a rejected promise and for the value on the GM client.
- **Roles are a UI concept for metadata.** Any role check in your extension runs in the user's browser.
  A user with developer tools can skip it.
- **All data reaches all clients.** Room, scene, item and player metadata are delivered to every
  client. Hidden items (`visible: false`) are still returned by `getItems` for players. "GM-only" data in
  metadata is readable by any player with developer tools. Hiding values from players is UI-only.

The only real privacy is **not publishing the value**. The official dice extension does not write the
values of a hidden roll at all (`owlbear-rodeo/dice` `src/plugin/DiceRollSync.tsx`).

### 7.3 Identity: `id` versus `connectionId`

| Field | Meaning |
|---|---|
| `Player.id` / `OBR.player.id` | The **user** ID. The same user in two tabs or on two devices has the same `id`. |
| `Player.connectionId` / `OBR.player.getConnectionId()` | Unique per **connection** (tab). |

[DOC: apis/player; SDK: `types/Player.d.ts`] Staff: "a player != user". One user with two tabs is two
players in the room. [STAFF]

- Use `connectionId` to tell connections apart (for example to elect a single writer).
- Use `id` to tie data to a person across reloads.
- In broadcasts, trust `event.connectionId` (the host sets it). Match it against `OBR.party.getPlayers()`
  to learn the sender's role. Do not trust a role or name inside the payload.
  [COMMUNITY: obr-suite `src/modules/musicBoard/README.md`]

---

## 8. Broadcast

[DOC: apis/broadcast; SDK: `api/BroadcastApi.js`]

```ts
await OBR.broadcast.sendMessage("com.example.my-ext/round", { round: 3 }, { destination: "ALL" });

const unsubscribe = OBR.broadcast.onMessage("com.example.my-ext/round", (event) => {
  event.data;          // the payload
  event.connectionId;  // the sender's connection
});
```

| `destination` | Who receives |
|---|---|
| `"REMOTE"` (default) | Other connected clients. **Not the sender.** |
| `"LOCAL"` | Only the current client. Use it to talk between your own iframes. |
| `"ALL"` | Everyone, including the sender. |

- `data` must be JSON-serializable and at most 16 kB.
- Messages are **ephemeral**. A client that joins later, reloads, or has no listener at that moment
  misses the message. Keep real state in metadata. Use broadcast only for notifications and commands.
- Use a reverse-domain channel name.
- `LOCAL` messages count against the same rate limit as remote ones. [COMMUNITY: obr-suite]
- `sendMessage` resolves when the host accepted it. It does not confirm delivery.
- [UNVERIFIED] Whether `LOCAL` reaches every iframe of your extension in this client (action, background,
  popovers). Published extensions rely on it (Pretty Sordid, Bubbles). Test with a listener in the
  background page and a send from the action popover.

---

## 9. Context menus

[DOC: apis/context-menu, reference/filters; SDK: `api/ContextMenuApi.js`, `types/ContextMenu.d.ts`]

```ts
OBR.contextMenu.create({
  id: "com.example.my-ext/menu",
  icons: [
    {
      icon: "/add.svg",
      label: "Add to tracker",
      filter: {
        every: [
          { key: "layer", value: "CHARACTER", coordinator: "||" },
          { key: "layer", value: "MOUNT" },
          { key: ["metadata", "com.example.my-ext/data"], value: undefined },
        ],
        permissions: ["UPDATE"],
      },
    },
    { icon: "/remove.svg", label: "Remove from tracker", filter: { permissions: ["UPDATE"] } },
  ],
  onClick(context, elementId) {
    // context.items: the selected items; context.selectionBounds
  },
});
```

### 9.1 Filters

- `ContextMenuIconFilter = { min?, max?, permissions?, roles?, every?, some? }`. `min` defaults to 1.
- `KeyFilter = { key: string | string[], value, operator?: "==" | "!=", coordinator?: "&&" | "||" }`.
  `key` can be a path such as `["metadata", "<id>"]`.
- With several icons, the docs say an icon is shown when its filter passes, and the menu item is hidden
  when none pass. [DOC: apis/context-menu] Published extensions use this to switch one menu id between
  "add" and "remove". [COMMUNITY] [UNVERIFIED: which icon wins when more than one filter passes. Make
  the filters exclusive.]
- `roles: ["GM"]` shows the item to GMs only. `permissions: ["UPDATE"]` hides it when the user cannot
  update the selected items.
- Filters cannot express "the owner is the current player". Check `createdUserId` in `onClick`.
  [COMMUNITY: obr-suite `src/modules/transform/index.ts`]
- `embed: { url, height? }` shows an iframe inside the context menu instead of a click.

### 9.2 Where `onClick` lives

The SDK stores the menu, with its `onClick`, in a map in **the iframe that called `create`**. The host
sends `OBR_CONTEXT_MENU_EVENT_CLICK` with the menu id. Each iframe's SDK looks up its own map.
[SDK: `api/ContextMenuApi.js`]

- If that iframe is gone (closed popover, reload without a new `create`), a click does nothing.
- If two iframes call `create` with the same id, the click handler runs in whichever iframes have the id
  in their map. [UNVERIFIED: whether the host sends the click to one iframe or to all.] Register each menu
  in **exactly one** iframe.
- Register menus in the **background page**, which is always loaded. [COMMUNITY: owl-trackers, GM's
  Grimoire, colored-rings, dynamic-fog, weather] The official initiative tracker registers its menu in
  the action popover. That works because the action iframe stays loaded.

### 9.3 Registration persistence

- The host stores menus by `id`. Calling `create` again with the same `id` replaces the menu. It does
  not add a second one. [COMMUNITY: obr-suite `src/modules/fullFog/index.ts`]
- A menu stays registered on the host after the iframe that created it reloads. [COMMUNITY] So use fixed
  ids, never random ids, and call `remove(id)` for menus you no longer want.
- `onClick` captures variables at the time of `create`. If the handler needs current state or the
  current role, read fresh state inside the handler (`await OBR.scene.getMetadata()`), or call `create`
  again with the same id when the role changes. [COMMUNITY: Pretty Sordid Initiative]
- There is no API to close the context menu. `OBR.player.deselect()` closes it in practice.
  [COMMUNITY: SDK issue #12]

### 9.4 `create` is not awaited

```js
// ContextMenuApi.js
create(contextMenu) {
  return __awaiter(this, ..., function* () {
    this.messageBus.sendAsync("OBR_CONTEXT_MENU_CREATE", {...});   // no yield
    this.contextMenus[contextMenu.id] = contextMenu;
  });
}
```

- The promise from `create` resolves at once. It does not wait for the host.
- A host error becomes an **unhandled promise rejection**. You cannot catch it.
- Only "not ready" rejects the returned promise (the synchronous throw in `send`).
- The local `onClick` is stored even if the host rejected the menu.
- `remove(id)` does await the host, then deletes the local handler.

---

## 10. Action API

[DOC: apis/action; SDK: `api/ActionApi.js`]

| Method | Purpose |
|---|---|
| `getWidth` / `setWidth`, `getHeight` / `setHeight` | Size of the action popover. Manifest values are the maximum. |
| `getBadgeText` / `setBadgeText(text?)` | Badge on the icon. `undefined` removes it. |
| `getBadgeBackgroundColor` / `setBadgeBackgroundColor` | Badge color. |
| `getIcon` / `setIcon`, `getTitle` / `setTitle` | Icon and tooltip. |
| `open()`, `close()`, `isOpen()`, `onOpenChange(cb)` | Open state. |

Auto-height pattern (https://github.com/owlbear-rodeo/initiative-tracker `src/InitiativeTracker.tsx`):

```tsx
useEffect(() => {
  const el = listRef.current;
  if (!el) return;
  const observer = new ResizeObserver((entries) => {
    const h = entries[0].contentRect.bottom + entries[0].contentRect.top;
    OBR.action.setHeight(Math.max(h, 64) + HEADER_HEIGHT);
  });
  observer.observe(el);
  return () => {
    observer.disconnect();
    OBR.action.setHeight(MANIFEST_HEIGHT);   // reset on unmount
  };
}, []);
```

The official sample uses `contentRect` because `borderBoxSize` was not available on iOS Safari in 2023.

---

## 11. Popovers, modals and notifications

### 11.1 Popover

`OBR.popover.open({ id, url, width, height, anchorElementId?, anchorPosition?, anchorOrigin?,
transformOrigin?, anchorReference?: "ELEMENT" | "POSITION", hidePaper?, disableClickAway?,
marginThreshold? })`; `close(id)`; `get/setWidth(id)`; `get/setHeight(id)`.
[DOC: apis/popover; SDK: `types/Popover.d.ts`]

- `elementId` from a context menu `onClick` can be the `anchorElementId`.
- An "invisible" popover can be made with `setHeight(id, 0)` and `setWidth(id, 0)`.
  [COMMUNITY: owlbear-rodeo/dice]
- Open bug: opening a popover or modal from a tool's `onToolClick` can make the tool unselectable until a
  refresh. (https://github.com/owlbear-rodeo/sdk/issues/4, open)

### 11.2 Modal

`OBR.modal.open({ id, url, width?, height?, fullScreen?, hideBackdrop?, hidePaper?,
disablePointerEvents? })`; `close(id)`. [DOC: apis/modal; SDK: `types/Modal.d.ts`]

Both are separate iframes. Pass small parameters in the URL query string (not personal data). Load
everything else from metadata when the iframe starts.

### 11.3 URL normalization

The SDK makes relative URLs absolute with this code [SDK: `common/normalize.js`]:

```js
url.startsWith("http") ? url : `${window.location.origin}${url}`
```

- It uses the **origin** only, not the current path. `"/popover.html"` means the root of your host.
  If your extension lives under a sub-path (for example GitHub Pages `/repo/`), include that path.
- A path **without** a leading `/` breaks: `"popover.html"` becomes `https://example.compopover.html`.
  Always start relative URLs with `/`.
- This applies to popover, modal and embed `url`, and to context menu and action icons.

### 11.4 Notification

`OBR.notification.show(message, variant?)` with variant `"DEFAULT" | "ERROR" | "INFO" | "SUCCESS" |
"WARNING"`. It returns an id for `close(id)`. [DOC: apis/notification]

---

## 12. Theme

[DOC: apis/theme; SDK: `api/ThemeApi.js`, `types/Theme.d.ts`]

```ts
interface Theme {
  mode: "DARK" | "LIGHT";
  primary: { light; main; dark; contrastText };
  secondary: { light; main; dark; contrastText };
  background: { default; paper };
  text: { primary; secondary; disabled };
}
```

Read it with `getTheme()` and follow it with `onChange`. The official sample maps it to an MUI theme
(https://github.com/owlbear-rodeo/initiative-tracker `src/PluginThemeProvider.tsx`):

```tsx
useEffect(() => {
  const update = (t: Theme) => setMuiTheme(createTheme({
    palette: {
      mode: t.mode === "LIGHT" ? "light" : "dark",
      text: t.text, primary: t.primary, secondary: t.secondary, background: t.background,
    },
  }));
  OBR.theme.getTheme().then(update);
  return OBR.theme.onChange(update);
}, []);
```

The verification guidelines require that the extension is readable in both light and dark themes.
[DOC: extension-verification]

---

## 13. Player and party APIs

### 13.1 Player

`Player = { id, connectionId, role: "GM" | "PLAYER", selection?: string[], name, color, syncView,
metadata }`. [SDK: `types/Player.d.ts`]

`OBR.player` methods: `id` (sync getter), `getId`, `getConnectionId`, `getRole`, `getName/setName`,
`getColor/setColor`, `getSyncView/setSyncView`, `getSelection`, `select(items, replace?)`,
`deselect(items?)`, `getMetadata/setMetadata`, `hasPermission(p)`, `onChange(cb)`.
[DOC: apis/player; SDK: `api/PlayerApi.js`]

### 13.2 Party

- `OBR.party.getPlayers()` returns the **other** players in the room. It does not include the current
  client. [DOC: apis/party]
- `OBR.party.onChange(cb(players))` fires when a player joins, leaves or changes. [DOC: apis/party]
- There can be **more than one GM**. Do not assume one.
- There can be **no GM online**. There is no server-side extension process, so any logic that needs a
  GM stops while no GM is connected. Design so players can still read the state.

### 13.3 Noisy `onChange`

- `OBR.player.onChange` fires for many unrelated changes: every selection change, name or color
  change, player metadata change, and also **scene `setMetadata`** (open issue
  https://github.com/owlbear-rodeo/sdk/issues/8).
- `OBR.party.onChange` fires for any change of any player, including selection and metadata.
- Compare only the fields you need (for example `role`) with the previous value before you react.

```ts
let lastRole: string | undefined;
OBR.player.onChange((p) => {
  if (p.role === lastRole) return;
  lastRole = p.role;
  onRoleChanged(p.role);
});
```

---

## 14. Scene items

[DOC: apis/scene/items; SDK: `api/scene/SceneItemsApi.js`]

- `getItems(filter?)`: an array of ids is looked up by the host. A predicate function makes the SDK
  fetch **all** items and filter them in the iframe.
- `addItems(items)` (use the `build*` builders), `deleteItems(ids)`, `getItemAttachments(ids)`,
  `getItemBounds(ids)`.
- `onChange(cb(items))`: every item in the scene on each change.
- Item fields include `id`, `type`, `name`, `visible`, `locked`, `createdUserId`, `zIndex`,
  `lastModified`, `lastModifiedUserId`, `position`, `rotation`, `scale`, `metadata`, `layer`,
  `attachedTo?`, `disableHit?`, `description?`. [DOC: reference/items/item]
- For image tokens, the visible label is `item.text.plainText`, with `item.name` as a fallback.
  [COMMUNITY: official initiative tracker]

### 14.1 How `updateItems` sends changes

```js
// SceneItemsApi.js (simplified)
const items = isItemArray(arg) ? arg : await this.getItems(arg);
const [next, patches] = produceWithPatches(items, recipe);   // immer
for (const { path: [index, key] } of patches) updates[index][key] = next[index][key];
// sends only items with changes, and for each item only the changed TOP-LEVEL keys
```

- The SDK sends the **whole value of each changed top-level property**. If you change
  `item.metadata[myKey].x`, the SDK sends the item's **whole `metadata` object**, as it was in the input
  items plus your change.
- **Danger:** if you pass an `Item[]` snapshot that is old, the stale `metadata` object overwrites
  newer metadata on the host, also other extensions' keys on that item.
- Pass **ids** (`updateItems([id], recipe)`) or a predicate. Then the SDK reads fresh items first. The
  window for a race is smaller, but it is still not atomic.
- A recipe that changes nothing sends no message.
- `OBR.scene.local` has the same API for local items, plus a `fastUpdate` flag on `updateItems`.
  [SDK: `api/scene/SceneLocalApi.js`]
- For high-frequency changes (dragging), use `OBR.interaction.startItemInteraction`. [DOC: apis/interaction]

---

## 15. Known SDK bugs and quirks

| # | Quirk | Source | Effect and workaround |
|---|---|---|---|
| 1 | Subscribe methods throw synchronously before ready. | SDK `messages/MessageBus.js` | Gate all code on `OBR.onReady`. |
| 2 | Subscriptions do not deliver the current value. | SDK `api/*.js` | Always `get` and then `on`. |
| 3 | Unsubscribe ids do not match subscribe ids: room metadata (`OBR_METADATA_ROOM_UNSUBSCRIBE` vs `OBR_ROOM_METADATA_SUBSCRIBE`), room permissions (`OBR_PERMISSIONS_ROOM_UNSUBSCRIBE`), action open (`OBR_IS_OPEN_ACTION_UNSUBSCRIBE`). | SDK `api/RoomApi.js`, `api/ActionApi.js` | The local listener is removed, so your callback stops. The host may keep sending events. Subscribe once and keep it, instead of many subscribe/unsubscribe cycles. |
| 4 | Unsubscribe sends one `..._UNSUBSCRIBE` per event type, with no listener id. | SDK `api/*.js` | [UNVERIFIED] If two components in one iframe subscribe to the same event and one unsubscribes, the host may stop events for both. React StrictMode subscribe/unsubscribe/subscribe works in practice. Safest: one subscription per event type per iframe, and fan out locally. |
| 5 | `contextMenu.create` does not await the host. | SDK `api/ContextMenuApi.js` | Host errors become unhandled rejections. |
| 6 | 5 s timeout leaves response listeners attached. | SDK `messages/MessageBus.js` | Small leak. A timed-out write may still land. |
| 7 | `updateItems` with an `Item[]` snapshot sends the whole stale `metadata`. | SDK `api/scene/SceneItemsApi.js` | Pass ids, not items. |
| 8 | `getItems(predicate)` fetches all items. | SDK `api/scene/SceneItemsApi.js` | Pass ids when you know them. |
| 9 | Relative URLs without a leading `/` break; sub-paths are ignored. | SDK `common/normalize.js` | Use `/path` or absolute URLs. |
| 10 | `MessageBus` sets `maxListeners` to 100. | SDK `messages/MessageBus.js` | More than 100 listeners on one event gives a console warning, a sign of a leak. Return unsubscribe functions from `useEffect`. |
| 11 | `player.onChange` fires on scene metadata writes and selections. | https://github.com/owlbear-rodeo/sdk/issues/8 (open) | Compare fields before you react. |
| 12 | `scene.setMetadata` type is `Metadata`, not `Partial<Metadata>`. | SDK `api/scene/SceneApi.d.ts` | Type only. |
| 13 | Popover/modal from `onToolClick` can make the tool unselectable. | https://github.com/owlbear-rodeo/sdk/issues/4 (open) | Avoid, or test. |
| 14 | `hasPermission` returns `true` for every GM without a check. | SDK `api/PlayerApi.js` | Expected, but note it. |
| 15 | Ctrl+Z inside an iframe does not reach OBR. | COMMUNITY: owlbear-rodeo/outliner | Forward to `OBR.scene.history`. |

---

## 16. Security

### 16.1 Isolation

Each extension runs in a cross-origin iframe. The SDK posts only to the host origin from `obrref` and
accepts only messages from that origin. [SDK: `messages/MessageBus.js`] Your extension cannot read the
OBR page. Other pages cannot send fake OBR messages to your iframe.

### 16.2 XSS through user text

Token names, `item.text.plainText`, item descriptions, player names and all metadata values come from
users. A real example of the risk: obr-fogofwar puts `${player.name}` into `innerHTML`
(https://github.com/ArmindoFlores/obr-fogofwar `main.js`).

- React and MUI escape text by default. Do not use `dangerouslySetInnerHTML` or `innerHTML` with these
  values.
- Do not put user text into URLs, CSS or `href` without encoding.

### 16.3 Validate untrusted metadata

Treat every metadata value as untrusted input. Other clients, other extensions, older versions of your
extension and a player with developer tools can all write it.

- Parse at the boundary: on every change event, convert the raw value into a typed object, with
  defaults. Drop or repair bad entries.
- Tools used by published extensions: `isPlainObject` plus type guards (official initiative tracker
  `src/isPlainObject.ts`), small `readNumber/readString` helpers (Pretty Sordid Initiative), and zod
  `safeParse` (owl-trackers).
- Never let a bad value crash the UI. Log it and use the default.
- Keep a `version` field and migrate old data (section 17.6).
- Do not put secrets in metadata. Every client receives it.

```ts
const KEY = "com.example.my-ext/state";
function readState(metadata: Record<string, unknown>): State {
  const raw = metadata[KEY];
  const parsed = StateSchema.safeParse(raw);
  if (!parsed.success) return defaultState();
  return migrate(parsed.data);
}
```

---

## 17. Best practices for state sync

### 17.1 Choose a write model

There is no compare-and-swap (section 6.2). Pick one of these models:

| Model | How | Good for | Risk |
|---|---|---|---|
| **Single writer** | One client (for example the GM, or an elected client) writes the shared state. Others send commands by broadcast or only read. | Complex state with rules that must stay consistent (decks, turn order) | Nothing changes when the writer is offline. Commands sent by broadcast are lost if the writer misses them. |
| **Merge by key** | Split state into many top-level keys or into item metadata, so that writers touch different keys. | Independent values (one value per token, one per player) | Two writers on the same key still conflict. The room budget is 16 kB. |
| **Whole object, last write wins** | One key holds everything. Any client writes it. | Small state with rare, human-paced writes | Lost updates when two clients write at the same time. |

Election example: "online GM first, then the lowest stable connection ID". [COMMUNITY: obr-suite
`src/modules/musicBoard/README.md`] The executor applies commands in order and drops duplicate command
ids.

### 17.2 Revisions

Put a `revision` (a counter) and optionally a `writer` (`connectionId`) in your state.

- Each write increments the revision.
- On a change event, ignore a value whose revision is not newer than the one you have. This also makes
  the echo of your own write a no-op.
- A command that carries an old revision can be rejected as stale. [COMMUNITY: obr-suite
  `three-dragon-ante/src/game/rules/engine.ts`]
- A revision does not prevent a lost update. It only lets you detect it.

### 17.3 Optimistic local update and debounce

- Update the local UI at once, then write. [COMMUNITY: official initiative tracker "Set local items
  immediately", then "Sync changes over the network"]
- When the change event arrives, it is the truth. Replace your local copy with it.
- Debounce fast edits (typing, sliders): apply the first call at once, then send a trailing write after
  about 200 ms. [COMMUNITY: owl-trackers `src/state/helpers/debouncerFactory.ts`]
- If a write fails, show an error and re-read the stored value.

### 17.4 Write only your own keys

Never write a spread of the whole cached metadata object:

```ts
// WRONG: writes stale copies of other extensions' keys
OBR.scene.setMetadata({ ...cachedMetadata, [KEY]: value });

// RIGHT
OBR.scene.setMetadata({ [KEY]: value });
```
[COMMUNITY: owl-trackers `src/state/helpers/updateState.ts` shows the wrong form]

### 17.5 Keep writes small

- Room metadata: 16 kB for all extensions together. Use it only for settings.
- Scene and item metadata: under 64 kB per update. A history or undo stack of full snapshots grows fast.
  Store diffs, keep a short history, or keep the history in local memory or localStorage of the writer.
- Broadcast: 16 kB per message.

### 17.6 Validation and migration by version

- Store `version` in your state.
- On read, migrate old versions step by step to the current one.
- Let **one** client (usually the GM) write the migrated data back. If every client migrates and writes,
  they race. [COMMUNITY: GM's Grimoire `src/background/init.ts` runs migrations only when the role is GM]
- Write default state only when the key is missing, and only from one client.
- An older client version can still be open in another tab. It may write the old format. Make the reader
  tolerant.

### 17.7 Cleanup of deleted items

If state in scene metadata refers to item ids, those items can be deleted at any time.

- Item metadata is deleted with the item. If you can store per-item data there, no cleanup is needed.
- Otherwise, on `items.onChange`, compute the referenced ids that are missing. Show them as missing, or
  skip them when you render. [COMMUNITY: Pretty Sordid Initiative `sortFromOrder` skips missing ids]
- If you prune them from metadata, let **one** client do it. All clients get the same event. If all
  write the cleanup, they race.

### 17.8 Unsubscribe every listener

- Every `on*` call returns an unsubscribe function. Return it from `useEffect`:
  `useEffect(() => OBR.scene.onMetadataChange(handle), [])`.
- In a background page, keep all unsubscribe functions of a scene session and call them on
  `onReadyChange(false)` (section 3.4).
- Call `contextMenu.remove(id)` for menus that should go away.

### 17.9 Checklist

1. Gate on `OBR.isAvailable` and `OBR.onReady`, then on scene ready.
2. `get` then `on` for every value you show.
3. Re-read everything on each scene ready. Reset in-memory state on scene close.
4. Namespaced keys. Write only your own keys.
5. Validate every incoming value. Version and migrate.
6. Decide who writes what. Use revisions. Ignore echoes.
7. Await writes. Catch `RateLimitHit` and timeouts. Tell the user.
8. Register context menus once, with fixed ids, in an iframe that stays loaded.
9. Treat all metadata as public. Do not publish values that players must not see.
10. Test with two browser windows (GM and player), with no scene open, during a scene switch, and after
    a reload.

---

## 18. Open questions and how to test them

These items cannot be settled from the SDK source or the docs. The host and server are closed source.
Test each one in a dev room with a GM window and a player window, and run the calls from the browser
console **of your extension iframe** (select the iframe in the console context menu).

| Question | How to test |
|---|---|
| Can a PLAYER write scene metadata? Room metadata? | As a player, `await OBR.scene.setMetadata({ "test/x": 1 })`. Check for a rejection and check the GM client. Repeat for `OBR.room.setMetadata`. |
| What happens over the size limit (16 kB room, 64 kB scene update)? | Write a value just over the limit. Await it. Reload and read it back. |
| Does `undefined` delete a key for good? | `setMetadata({ k: undefined })`, reload, then `"k" in (await OBR.scene.getMetadata())`. |
| What do scene calls do with no scene open? | Close the scene. Call `OBR.scene.getMetadata()`. Note whether it rejects at once, with what payload, or after 5 s. |
| Do metadata and item change events fire on a scene switch? | Subscribe, switch scenes, and log events. |
| Does the change event arrive before or after the write promise resolves? | Log timestamps for both in the writing client. |
| Does `LOCAL` broadcast reach all your iframes? | Listen in the background page and in a popover. Send from the action popover. |
| Does the host send a context menu click to one iframe or all that registered the id? | Register the same id in two iframes. Click. Log in both. |
| Does the action iframe stay loaded while closed, on all platforms (including mobile)? | Log a timer from the action iframe. Close the popover. Watch the log. |
| Does one unsubscribe stop events for other subscribers of the same type in that iframe? | Subscribe twice to `scene.onMetadataChange`. Unsubscribe one. Write. See if the other fires. |
| What are the rate limits? | Send broadcasts in a tight loop. Note when `RateLimitHit` starts and how long it lasts. |
| Are local items kept across a scene switch? Are they on the undo stack? | Add a local item, switch scenes and back. Add one, press Ctrl+Z. |
