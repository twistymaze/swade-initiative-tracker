/**
 * In-memory fake of `@owlbear-rodeo/sdk` for Vitest.
 *
 * Usage in a test file:
 *
 *   import { vi, beforeEach } from "vitest";
 *   vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));
 *   import { obr, resetObrMock, flushObr } from "../test/obrMock";
 *
 *   beforeEach(() => resetObrMock());
 *
 * App code that does `import OBR from "@owlbear-rodeo/sdk"` talks to the
 * hub's *active client*. API methods are `vi.fn` spies, so
 * `expect(obr().action.setHeight).toHaveBeenCalledWith(...)` works.
 *
 * Model:
 * - A hub is the shared backend: room metadata, scene (ready flag, metadata,
 *   items) and the broadcast bus.
 * - A client is one connected browser. It owns its player (id, name, role,
 *   metadata), theme, action/contextMenu/modal/notification state and its
 *   listeners. `hub().createClient()` adds clients for multi-client tests and
 *   `hub().setActiveClient(c)` picks which one the default OBR export is.
 * - setMetadata does a shallow top-level merge; a key set to `undefined` is
 *   deleted. Values are JSON-cloned, like real OBR (no shared references).
 * - Change listeners fire on every client, the writer included, in a
 *   microtask after the write. `await flushObr()` lets them run.
 * - Failure injection: `client.failRoom("setMetadata", rateLimitError(), 2)`,
 *   `client.delayNextRoomRead()` (returns a release function),
 *   `client.setOwnEcho(100 | "never")` (the writer gets the echo of its own room
 *   writes that many ms after setMetadata resolves, or never),
 *   `client.dropRoomEvents(n)` (the next n room events of that client are lost),
 *   `client.setWriteDelay(ms | () => ms)` (each setMetadata lands and resolves only
 *   after that delay, so writes are in flight; events still arrive in room order) and
 *   `hub().roomSizeLimit` (writes over the limit reject, nothing changes).
 * - Each client is a separate connection, so a test can pass a client object
 *   straight to code that takes an OBR-like dependency (one store per client).
 */
import { vi } from "vitest";
import type { Item, Metadata, Player, Theme } from "@owlbear-rodeo/sdk";

export type Role = "GM" | "PLAYER";
type Listener<T> = (value: T) => void;
type ItemFilter = string[] | ((item: Item) => boolean);
type BroadcastEvent = { data: unknown; connectionId: string };
type Destination = "REMOTE" | "LOCAL" | "ALL";
type OwnEcho = "normal" | "never" | number;
// The SDK's ContextMenuItem / Modal shapes; kept loose on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

export interface ClientOptions {
  id?: string;
  name?: string;
  role?: Role;
}

export const DEFAULT_THEME: Theme = {
  mode: "DARK",
  primary: { light: "#ebcdff", main: "#bb99ff", dark: "#8a6acc", contrastText: "#000" },
  secondary: { light: "#ffa5b8", main: "#ee99ff", dark: "#bb66cc", contrastText: "#000" },
  background: { default: "#1e2231", paper: "#222639" },
  text: { primary: "#fff", secondary: "rgba(255,255,255,0.7)", disabled: "rgba(255,255,255,0.5)" },
};

/** The host's rate limit rejection payload. */
export const rateLimitError = () => ({ error: { name: "RateLimitHit", message: "Too many requests" } });

/** The SDK's timeout rejection. */
export const timeoutError = (id = "OBR_ROOM_SET_METADATA") => new Error(`Message ${id} took longer than 5000ms to get a result`);

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/** Shallow top-level merge; `undefined` deletes the key. */
function mergeMetadata(target: Metadata, patch: Partial<Metadata>): Metadata {
  const next: Metadata = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = clone(value);
  }
  return next;
}

/** Listener set. Each listener gets its own clone, delivered in a microtask. */
class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  emit(value: T) {
    for (const fn of [...this.listeners]) {
      const copy = clone(value);
      queueMicrotask(() => {
        if (this.listeners.has(fn)) fn(copy);
      });
    }
  }
  get size() {
    return this.listeners.size;
  }
}

/** Await after a write to let async change listeners (and their awaits) run. */
export async function flushObr(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function filterItems(items: Item[], filter?: ItemFilter): Item[] {
  if (!filter) return items;
  if (Array.isArray(filter)) return items.filter((i) => filter.includes(i.id));
  return items.filter(filter);
}

let clientCounter = 0;

export type ObrClient = ReturnType<typeof buildClient>;

function buildClient(hub: ObrHub, options: ClientOptions) {
  clientCounter++;
  const state = {
    player: {
      id: options.id ?? `player-${clientCounter}`,
      connectionId: `conn-${clientCounter}`,
      role: options.role ?? "PLAYER",
      name: options.name ?? `Player ${clientCounter}`,
      color: "#ff0000",
      syncView: false,
      selection: [],
      metadata: {},
    } as Player,
    theme: clone(DEFAULT_THEME),
    action: {
      height: 0,
      width: 300,
      badgeText: undefined as string | undefined,
      badgeBackgroundColor: undefined as string | undefined,
      title: "",
      isOpen: true,
    },
    contextMenus: new Map<string, Loose>(),
    modals: new Map<string, Loose>(),
    /** When this client gets the echo of its own room writes (see setOwnEcho). */
    ownEcho: "normal" as OwnEcho,
    /** Delay (ms) before each room setMetadata lands and resolves (see setWriteDelay). */
    writeDelay: (() => 0) as () => number,
    /** Room change events this client still loses (see dropRoomEvents). */
    droppedRoomEvents: 0,
    notifications: [] as { id: string; message: string; variant?: string }[],
  };
  const emitters = {
    room: new Emitter<Metadata>(),
    scene: new Emitter<Metadata>(),
    sceneReady: new Emitter<boolean>(),
    items: new Emitter<Item[]>(),
    player: new Emitter<Player>(),
    theme: new Emitter<Theme>(),
    broadcast: new Map<string, Emitter<BroadcastEvent>>(),
  };
  const updatePlayer = (patch: Partial<Player>) => {
    state.player = { ...state.player, ...patch };
    emitters.player.emit(state.player);
  };

  const client = {
    // ---------- test-only handles (not part of the SDK) ----------
    hub,
    state,
    emitters,
    /**
     * How this client gets the room change event of its own setMetadata: "normal" (in a
     * microtask, before setMetadata resolves), a delay in ms after it resolves, or "never".
     * Other clients always get the event normally.
     */
    setOwnEcho: (mode: OwnEcho) => {
      state.ownEcho = mode;
    },
    /**
     * Keep each room setMetadata in flight: it lands (and resolves) only after `delay` ms
     * (a number, or a function called once per write). Applies to the default implementation.
     */
    setWriteDelay: (delay: number | (() => number)) => {
      state.writeDelay = typeof delay === "number" ? () => delay : delay;
    },
    /**
     * Lose the next `count` room change events of this client (e.g. a dropped connection):
     * the room changes, but this client is not told.
     */
    dropRoomEvents: (count = 1) => {
      state.droppedRoomEvents += count;
    },
    /** Change this client's role and fire player.onChange. */
    setRole: (role: Role) => updatePlayer({ role }),
    setTheme: (theme: Theme) => {
      state.theme = clone(theme);
      emitters.theme.emit(state.theme);
    },
    /** Run a registered context menu's onClick as if the user clicked it. */
    clickContextMenu: (id: string, items: Item[], selectedIcon = "") => {
      const menu = state.contextMenus.get(id);
      if (!menu) throw new Error(`obrMock: no context menu with id "${id}"`);
      return menu.onClick?.({ items, selectionBounds: undefined }, selectedIcon);
    },
    /** Make the next `times` calls of room.getMetadata / room.setMetadata reject with `error`. */
    failRoom: (method: "getMetadata" | "setMetadata", error: unknown, times = 1) => {
      for (let i = 0; i < times; i++) client.room[method].mockRejectedValueOnce(error);
    },
    /**
     * The next room.getMetadata reads the room now but resolves only when the
     * returned function is called.
     */
    delayNextRoomRead: (): (() => void) => {
      let release = () => {};
      client.room.getMetadata.mockImplementationOnce(() => {
        const snapshot = clone(hub.roomMetadata);
        return new Promise<Metadata>((resolve) => {
          release = () => resolve(snapshot);
        });
      });
      return () => release();
    },

    // ---------- SDK surface ----------
    isAvailable: true,
    isReady: true,
    onReady: vi.fn((cb: () => void) => {
      queueMicrotask(cb);
    }),

    room: {
      get id() {
        return hub.roomId;
      },
      getMetadata: vi.fn(async () => clone(hub.roomMetadata)),
      setMetadata: vi.fn(async (patch: Partial<Metadata>) => {
        const wait = state.writeDelay();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const mode = state.ownEcho;
        if (mode === "normal") return hub.writeRoomMetadata(patch);
        hub.writeRoomMetadata(patch, client);
        const written = hub.roomMetadata;
        if (typeof mode === "number") setTimeout(() => emitters.room.emit(written), mode);
      }),
      onMetadataChange: vi.fn((cb: Listener<Metadata>) => emitters.room.on(cb)),
      getPermissions: vi.fn(async () => [] as string[]),
      onPermissionsChange: vi.fn(() => () => {}),
    },

    scene: {
      isReady: vi.fn(async () => hub.sceneReady),
      onReadyChange: vi.fn((cb: Listener<boolean>) => emitters.sceneReady.on(cb)),
      getMetadata: vi.fn(async () => {
        hub.assertSceneReady();
        return clone(hub.sceneMetadata);
      }),
      setMetadata: vi.fn(async (patch: Partial<Metadata>) => hub.writeSceneMetadata(patch)),
      onMetadataChange: vi.fn((cb: Listener<Metadata>) => emitters.scene.on(cb)),
      items: {
        getItems: vi.fn(async (filter?: ItemFilter) => {
          hub.assertSceneReady();
          return clone(filterItems(hub.items, filter));
        }),
        updateItems: vi.fn(async (filterOrItems: ItemFilter | Item[], update: (drafts: Item[]) => void) => {
          hub.assertSceneReady();
          const filter: ItemFilter =
            Array.isArray(filterOrItems) && filterOrItems.length > 0 && typeof filterOrItems[0] === "object"
              ? (filterOrItems as Item[]).map((i) => i.id)
              : (filterOrItems as ItemFilter);
          const drafts = clone(filterItems(hub.items, filter));
          update(drafts); // drafts are mutable copies, like immer drafts
          const byId = new Map(drafts.map((d) => [d.id, d]));
          hub.setItems(hub.items.map((i) => byId.get(i.id) ?? i));
        }),
        addItems: vi.fn(async (items: Item[]) => hub.setItems([...hub.items, ...items])),
        deleteItems: vi.fn(async (ids: string[]) => hub.setItems(hub.items.filter((i) => !ids.includes(i.id)))),
        getItemAttachments: vi.fn(async (ids: string[]) =>
          clone(hub.items.filter((i) => ids.includes(i.id) || (i.attachedTo !== undefined && ids.includes(i.attachedTo))))
        ),
        getItemBounds: vi.fn(async () => ({
          min: { x: 0, y: 0 },
          max: { x: 100, y: 100 },
          width: 100,
          height: 100,
          center: { x: 50, y: 50 },
        })),
        onChange: vi.fn((cb: Listener<Item[]>) => emitters.items.on(cb)),
      },
    },

    player: {
      get id() {
        return state.player.id;
      },
      getId: vi.fn(async () => state.player.id),
      getConnectionId: vi.fn(async () => state.player.connectionId),
      getRole: vi.fn(async () => state.player.role),
      getName: vi.fn(async () => state.player.name),
      setName: vi.fn(async (name: string) => updatePlayer({ name })),
      getColor: vi.fn(async () => state.player.color),
      getSelection: vi.fn(async () => clone(state.player.selection)),
      select: vi.fn(async (ids: string[], replace = true) =>
        updatePlayer({ selection: replace ? ids : [...(state.player.selection ?? []), ...ids] })
      ),
      deselect: vi.fn(async () => updatePlayer({ selection: [] })),
      getMetadata: vi.fn(async () => clone(state.player.metadata)),
      setMetadata: vi.fn(async (patch: Partial<Metadata>) =>
        updatePlayer({ metadata: mergeMetadata(state.player.metadata, patch) })
      ),
      onChange: vi.fn((cb: Listener<Player>) => emitters.player.on(cb)),
    },

    party: {
      getPlayers: vi.fn(async (): Promise<Player[]> => clone(hub.clients.filter((c) => c !== client).map((c) => c.state.player))),
      onChange: vi.fn(() => () => {}),
    },

    contextMenu: {
      create: vi.fn(async (item: Loose) => {
        state.contextMenus.set(item.id, item);
      }),
      remove: vi.fn(async (id: string) => {
        state.contextMenus.delete(id);
      }),
    },

    action: {
      getHeight: vi.fn(async () => state.action.height),
      setHeight: vi.fn(async (height: number) => {
        state.action.height = height;
      }),
      getWidth: vi.fn(async () => state.action.width),
      setWidth: vi.fn(async (width: number) => {
        state.action.width = width;
      }),
      getBadgeText: vi.fn(async () => state.action.badgeText),
      setBadgeText: vi.fn(async (text?: string) => {
        state.action.badgeText = text;
      }),
      getBadgeBackgroundColor: vi.fn(async () => state.action.badgeBackgroundColor),
      setBadgeBackgroundColor: vi.fn(async (color: string) => {
        state.action.badgeBackgroundColor = color;
      }),
      getTitle: vi.fn(async () => state.action.title),
      setTitle: vi.fn(async (title: string) => {
        state.action.title = title;
      }),
      setIcon: vi.fn(async () => {}),
      isOpen: vi.fn(async () => state.action.isOpen),
      open: vi.fn(async () => {
        state.action.isOpen = true;
      }),
      close: vi.fn(async () => {
        state.action.isOpen = false;
      }),
      onOpenChange: vi.fn(() => () => {}),
    },

    modal: {
      open: vi.fn(async (modal: Loose) => {
        state.modals.set(modal.id, modal);
      }),
      close: vi.fn(async (id: string) => {
        state.modals.delete(id);
      }),
    },

    theme: {
      getTheme: vi.fn(async () => clone(state.theme)),
      onChange: vi.fn((cb: Listener<Theme>) => emitters.theme.on(cb)),
    },

    broadcast: {
      sendMessage: vi.fn(async (channel: string, data: unknown, options?: { destination?: Destination }) =>
        hub.broadcast(client, channel, data, options?.destination ?? "REMOTE")
      ),
      onMessage: vi.fn((channel: string, cb: Listener<BroadcastEvent>) => {
        let emitter = emitters.broadcast.get(channel);
        if (!emitter) {
          emitter = new Emitter<BroadcastEvent>();
          emitters.broadcast.set(channel, emitter);
        }
        return emitter.on(cb);
      }),
    },

    notification: {
      show: vi.fn(async (message: string, variant?: string) => {
        const id = `notification-${state.notifications.length + 1}`;
        state.notifications.push({ id, message, variant });
        return id;
      }),
      close: vi.fn(async () => {}),
    },

    viewport: {
      getWidth: vi.fn(async () => 1000),
      getHeight: vi.fn(async () => 800),
      getScale: vi.fn(async () => 1),
      setScale: vi.fn(async () => {}),
      getPosition: vi.fn(async () => ({ x: 0, y: 0 })),
      setPosition: vi.fn(async () => {}),
      animateTo: vi.fn(async () => {}),
      animateToBounds: vi.fn(async () => {}),
      reset: vi.fn(async () => 1),
      transformPoint: vi.fn(async (p: { x: number; y: number }) => p),
      inverseTransformPoint: vi.fn(async (p: { x: number; y: number }) => p),
    },
  };
  return client;
}

/** Shared backend for any number of clients. */
export class ObrHub {
  roomId = "test-room";
  roomMetadata: Metadata = {};
  sceneReady = true;
  sceneMetadata: Metadata = {};
  items: Item[] = [];
  readonly clients: ObrClient[] = [];
  activeClient: ObrClient;

  constructor(gm: ClientOptions = { id: "player-gm", name: "GM", role: "GM" }) {
    this.activeClient = this.createClient(gm);
  }

  createClient(options: ClientOptions = {}): ObrClient {
    const client = buildClient(this, options);
    this.clients.push(client);
    return client;
  }

  /** Pick which client the default `OBR` export represents. */
  setActiveClient(client: ObrClient) {
    this.activeClient = client;
  }

  assertSceneReady() {
    if (!this.sceneReady) throw new Error("obrMock: no scene is open");
  }

  /** When set, a room write whose result is larger (JSON bytes) rejects. */
  roomSizeLimit: number | undefined = undefined;

  /** Write room metadata and notify every client except `silent` (if given). */
  writeRoomMetadata(patch: Partial<Metadata>, silent?: ObrClient) {
    const next = mergeMetadata(this.roomMetadata, patch);
    if (this.roomSizeLimit !== undefined && new TextEncoder().encode(JSON.stringify(next)).length > this.roomSizeLimit) {
      throw { error: { name: "MetadataTooLarge", message: "obrMock: room metadata over size limit" } };
    }
    this.roomMetadata = next;
    for (const c of this.clients) {
      if (c === silent) continue;
      if (c.state.droppedRoomEvents > 0) c.state.droppedRoomEvents--;
      else c.emitters.room.emit(this.roomMetadata);
    }
  }

  writeSceneMetadata(patch: Partial<Metadata>) {
    this.assertSceneReady();
    this.sceneMetadata = mergeMetadata(this.sceneMetadata, patch);
    for (const c of this.clients) c.emitters.scene.emit(this.sceneMetadata);
  }

  setItems(items: Item[]) {
    this.items = clone(items);
    for (const c of this.clients) c.emitters.items.emit(this.items);
  }

  /** Open (true) or close (false) the scene. Closing clears scene metadata and items. */
  setSceneReady(ready: boolean) {
    this.sceneReady = ready;
    if (!ready) {
      this.sceneMetadata = {};
      this.items = [];
    }
    for (const c of this.clients) c.emitters.sceneReady.emit(ready);
  }

  broadcast(from: ObrClient, channel: string, data: unknown, destination: Destination) {
    for (const c of this.clients) {
      const isSelf = c === from;
      if (destination === "REMOTE" && isSelf) continue;
      if (destination === "LOCAL" && !isSelf) continue;
      c.emitters.broadcast.get(channel)?.emit({ data, connectionId: from.state.player.connectionId });
    }
  }
}

// ---------------- module-level default hub + helpers ----------------

let currentHub = new ObrHub();

/** The current shared hub. */
export const hub = () => currentHub;
/** The active client (what app code sees as `OBR`). */
export const obr = () => currentHub.activeClient;

/** Fresh hub with one GM client. Call in beforeEach. */
export function resetObrMock(gm?: ClientOptions): ObrHub {
  currentHub = new ObrHub(gm);
  return currentHub;
}

/** Set the active client's role (fires player.onChange). */
export const setRole = (role: Role) => obr().setRole(role);

/** Toggle scene ready state (fires scene.onReadyChange on all clients). */
export const setSceneReady = (ready: boolean) => currentHub.setSceneReady(ready);

/**
 * Simulate a write by some other client that is not modelled as an ObrClient.
 * Listeners on every client fire, as with a real remote change.
 */
export function simulateRemoteWrite(target: "room" | "scene", patch: Partial<Metadata>) {
  if (target === "room") currentHub.writeRoomMetadata(patch);
  else currentHub.writeSceneMetadata(patch);
}

/** Add another client sharing the current hub (for multi-client sync tests). */
export const createClient = (options?: ClientOptions) => currentHub.createClient(options);

/**
 * Default export stand-in: every property reads through to the active client
 * at call time, so resetObrMock()/setActiveClient() take effect for modules
 * that captured `OBR` at import.
 */
const OBRProxy = new Proxy({} as ObrClient, {
  get: (_t, prop) => Reflect.get(currentHub.activeClient, prop),
  has: (_t, prop) => prop in currentHub.activeClient,
});

/**
 * Module factory for `vi.mock("@owlbear-rodeo/sdk", ...)`. Re-exports the
 * SDK's pure math helpers (Math2, Vector2, MathM) and replaces the default
 * export with the fake. Builders are not provided.
 */
export async function createSdkModule() {
  const math = await import("@owlbear-rodeo/sdk/lib/math");
  return { ...math, default: OBRProxy };
}

// ---------------- BroadcastChannel fake ----------------

/**
 * Same-origin BroadcastChannel stand-in: a message goes to every other open channel with
 * the same name (not the sender), as a structured clone, in a microtask. Install with
 * `vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel)`; `FakeBroadcastChannel.reset()`
 * closes all channels. `FakeBroadcastChannel.post(name, data)` posts from outside (another page).
 */
export class FakeBroadcastChannel {
  private static open = new Set<FakeBroadcastChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  private closed = false;

  constructor(readonly name: string) {
    FakeBroadcastChannel.open.add(this);
  }

  static reset() {
    for (const channel of FakeBroadcastChannel.open) channel.closed = true;
    FakeBroadcastChannel.open.clear();
  }

  static post(name: string, data: unknown, from?: FakeBroadcastChannel) {
    for (const channel of [...FakeBroadcastChannel.open]) {
      if (channel === from || channel.name !== name) continue;
      const copy = structuredClone(data);
      queueMicrotask(() => {
        if (!channel.closed) channel.onmessage?.({ data: copy } as MessageEvent);
      });
    }
  }

  /** Open channels with this name (test-only). */
  static count(name: string) {
    return [...FakeBroadcastChannel.open].filter((c) => c.name === name).length;
  }

  postMessage(data: unknown) {
    if (this.closed) throw new Error("obrMock: BroadcastChannel is closed");
    FakeBroadcastChannel.post(this.name, data, this);
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.open.delete(this);
  }
}
