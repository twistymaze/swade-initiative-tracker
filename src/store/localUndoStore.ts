// Local undo stack. NOT synced to room metadata: each browser tab (OBR connection) keeps
// its own history in sessionStorage (one key per room). sessionStorage is per top-level
// tab and shared by the same-origin iframes in it (popover, modals, background page), and
// it survives a reload. Other tabs of the same browser do not see it, so one tab's Undo
// never offers another tab's action. Falls back to memory when sessionStorage is unavailable.
// Older versions kept the history in localStorage (shared by all tabs); those keys are
// removed on start, never imported.
//
// Rules (see review S6 / U3):
// - A state is identified by {revision, writerId}. Each checkpoint stores the content
//   before an action (`before`) and the identity of the state the action produced (`after`).
// - captureCheckpoint(desc) only opens a capture window for the current task. The
//   checkpoint is pushed on the first change made by this iframe in that window; more
//   changes in the same task move its `after` forward. When the task ends without a
//   local change (e.g. a modal was opened and then cancelled), nothing is recorded.
// - Undo is possible only while the current state is exactly the top checkpoint's
//   `after` (nobody changed the room since), and the room holds no newer state that
//   this iframe has seen but not adopted yet (a write of its own is pending). It
//   dispatches restoreSnapshot, a normal stamped action, so the restore gets a new,
//   higher revision and syncs normally.
// - Adopting another state never clears the stack: Undo just turns off while the top
//   does not match (identities are unique, so it cannot match by accident). Iframes of
//   one tab see room events at different times, so clearing on adopt would drop
//   checkpoints that another iframe just made. The next captured action whose starting
//   state is not the top's `after` starts a new history.
// - A change that only re-stamps the state (same content, new revision; the sync
//   engine does this before a write) moves the top's `after` along.
// - When the sync engine rebases the local state onto another GM's concurrent change
//   (rebaseOrigins), a top checkpoint that covers exactly the replayed actions now starts
//   from that foreign state: Undo restores it, so it never erases the foreign change. Older
//   checkpoints are dropped (they would). Otherwise Undo turns off, as after any adoption.
// - sessionStorage is the source of truth: the stack is re-read before every decision.
//   Sibling iframes of the tab are told to re-read it by the `storage` event (the HTML
//   spec fires it for sessionStorage changes to other same-origin documents of the tab)
//   and, in case a browser does not, by a BroadcastChannel message. The channel name holds
//   a per-tab id kept in sessionStorage, so other tabs do not get the messages.
// - A duplicated browser tab starts with a copy of the original tab's sessionStorage (tab id
//   and histories). A liveness lease (TabLease) tells it apart from a reload without a timing
//   window: every document that loads this module adds its id to a list in sessionStorage
//   (UNDO_LEASE_KEY) synchronously at module start, and removes it on `pagehide` (re-adds it
//   on a bfcache `pageshow`). `pagehide` fires before a reload's new document runs, so a
//   reloaded document finds no other live document of the tab. A duplicate is copied while
//   the original's documents are live, so it finds their ids. A document that finds other
//   ids asks them on a browser-wide BroadcastChannel; it has first written a random probe
//   key into its own sessionStorage. Each listed document answers whether it sees that probe
//   in its own sessionStorage: yes = same tab (a sibling iframe), no = another tab (this tab
//   is a duplicate: new tab id, empty history). A listed document that leaves first says
//   `bye`; it is of this tab if it has removed itself from this tab's list. Listed documents
//   that never answer (left without `pagehide`, e.g. a crash) are dropped after a time-out;
//   if no listed document answered "same tab", the tab counts as a duplicate (the safe
//   side: lose the history rather than share it). Until the check ends, the stored history
//   is not read or written.

import type { UnknownAction } from '@reduxjs/toolkit';
import type { EncounterState } from './types';
import { restoreSnapshot } from './swadeSlice';
import { parseEncounterState } from './stateCodec';
import { rebaseOrigins } from './syncEngine';

export interface StateIdentity {
  revision: number;
  writerId: string;
}

export interface UndoCheckpoint {
  before: EncounterState;
  description: string;
  after: StateIdentity;
  timestamp: number;
}

export interface UndoStoreDeps {
  /** This iframe's Redux store (createAppStore). */
  store: {
    getState(): { swade: EncounterState };
    dispatch(action: UnknownAction): unknown;
    subscribe(listener: () => void): () => void;
  };
  /** This iframe's writer id (the one the store stamps on local changes). */
  writerId: string;
  /** OBR room id; one undo history per room. */
  roomId: string;
  /** Newest state identity seen in the room, adopted or not (syncEngine.getRoomIdentity). */
  getRoomIdentity?: () => StateIdentity | null;
  /** Storage to use; defaults to sessionStorage, or memory if sessionStorage is unavailable. */
  storage?: Storage;
  /** Storage of older versions (shared by all tabs); its undo keys are removed on start. Default: localStorage. */
  legacyStorage?: Storage | null;
  /** Creates the channel that tells sibling iframes of this tab to re-read the stack. Default: BroadcastChannel; null: none. */
  channel?: ((name: string) => UndoChannel) | null;
  /** Window to listen on for `storage` events (default: globalThis window, if any). */
  eventTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  maxCheckpoints?: number;
  /**
   * This document's liveness lease (detects a duplicated tab). Default: the lease made at
   * module start when the storage is sessionStorage, else none (no check).
   */
  lease?: TabLease | null;
}

/** The subset of BroadcastChannel the undo store uses. */
export interface UndoChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export const UNDO_STORAGE_PREFIX = 'swade-undo-v2-';
/** sessionStorage key of this tab's id (scopes the BroadcastChannel to the tab). */
export const UNDO_TAB_ID_KEY = 'swade-undo-tab-id';
/** sessionStorage key of the ids of this tab's live documents (the liveness lease). */
export const UNDO_LEASE_KEY = 'swade-undo-lease';
/** Browser-wide channel on which documents answer the lease check. */
export const UNDO_LEASE_CHANNEL = 'swade-undo-lease';
const PROBE_PREFIX = 'swade-undo-probe:';
/** Key of older versions (connection id that owned the tab id); removed on start. */
const OLD_OWNER_KEY = 'swade-undo-tab-owner';
const DEFAULT_LEASE_TIMEOUT_MS = 2000;
const LEGACY_PREFIX = 'swade-undo-';
/** Histories of other rooms older than this are removed on start. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CHECKPOINTS = 20;

const identityOf = (state: EncounterState): StateIdentity => ({ revision: state.revision, writerId: state.writerId });
const sameIdentity = (a: StateIdentity, b: StateIdentity) => a.revision === b.revision && a.writerId === b.writerId;

const debug = (...args: unknown[]) => {
  if (import.meta.env.DEV && import.meta.env.MODE !== 'test') console.debug('[Undo]', ...args);
};

/** Minimal in-memory Storage, shared by all undo stores of this iframe. */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

const memoryStorage = new MemoryStorage();

function defaultStorage(): Storage {
  try {
    const storage = globalThis.sessionStorage;
    const probe = `${UNDO_STORAGE_PREFIX}probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return memoryStorage;
  }
}

function defaultLegacyStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultChannel(name: string): UndoChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  const channel = new BroadcastChannel(name);
  // Node (tests): do not keep the process alive.
  (channel as unknown as { unref?: () => void }).unref?.();
  return channel;
}

function randomId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

// ---------- liveness lease (duplicated-tab detection; see the header comment) ----------

export type TabVerdict = 'kept' | 'duplicate';

type LeaseMessage =
  | { type: 'who'; nonce: string; docs: string[] }
  | { type: 'here'; nonce: string; docId: string; sameTab: boolean }
  | { type: 'bye'; docId: string };

export interface TabLeaseOptions {
  /** The tab's sessionStorage. */
  storage: Storage;
  /** Window to listen on for pagehide / pageshow (default: globalThis window, if any). */
  eventTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  /** Creates the browser-wide lease channel. Default: BroadcastChannel; null: none (no check). */
  channel?: ((name: string) => UndoChannel) | null;
  /** How long to wait for listed documents that do not answer (default 2000 ms). */
  timeoutMs?: number;
}

function readDocs(storage: Storage): string[] {
  const raw = storage.getItem(UNDO_LEASE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDocs(storage: Storage, docs: string[]) {
  if (docs.length === 0) storage.removeItem(UNDO_LEASE_KEY);
  else storage.setItem(UNDO_LEASE_KEY, JSON.stringify([...new Set(docs)]));
}

/** Remove the histories of all rooms (a duplicated tab's copies of the original tab's). */
function removeAllHistories(storage: Storage) {
  const remove: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(UNDO_STORAGE_PREFIX)) remove.push(key);
  }
  for (const key of remove) storage.removeItem(key);
}

/** One document's entry in its tab's liveness lease. Registers synchronously on construction. */
export class TabLease {
  readonly docId = randomId();
  /** Set once the check has ended (or when no check is needed). */
  verdict: TabVerdict | null = null;
  private readonly storage: Storage;
  private readonly timeoutMs: number;
  private readonly eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  private channel: UndoChannel | null = null;
  /** Documents listed in the lease when this one registered. */
  private readonly others: string[] = [];
  private tabIdAtStart: string | null = null;
  private live = false;
  private checking: Promise<TabVerdict> | null = null;
  private onCheckMessage: ((message: LeaseMessage) => void) | null = null;

  constructor(options: TabLeaseOptions) {
    this.storage = options.storage;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
    this.eventTarget =
      options.eventTarget !== undefined ? options.eventTarget : typeof window === 'undefined' ? null : window;
    try {
      this.others = readDocs(this.storage);
      this.tabIdAtStart = this.storage.getItem(UNDO_TAB_ID_KEY);
      writeDocs(this.storage, [...this.others, this.docId]);
      this.storage.removeItem(OLD_OWNER_KEY);
      this.live = true;
    } catch (error) {
      console.warn('[Undo] Could not register in the tab lease:', error);
      this.verdict = 'kept';
    }
    const factory = options.channel === undefined ? defaultChannel : options.channel;
    try {
      this.channel = factory ? factory(UNDO_LEASE_CHANNEL) : null;
      if (this.channel) this.channel.onmessage = this.onMessage;
    } catch (error) {
      console.warn('[Undo] Could not open the lease channel:', error);
      this.channel = null;
    }
    // Nobody else listed: a new tab or a reload. No channel: no way to ask; keep (older behaviour).
    if (this.others.length === 0 || !this.channel) this.verdict ??= 'kept';
    this.eventTarget?.addEventListener('pagehide', this.onPageHide);
    this.eventTarget?.addEventListener('pageshow', this.onPageShow);
  }

  /** Resolves with this document's verdict; the check runs once per document. */
  check(): Promise<TabVerdict> {
    if (this.verdict) return Promise.resolve(this.verdict);
    this.checking ??= new Promise<TabVerdict>((resolve) => {
      const nonce = randomId();
      const probe = PROBE_PREFIX + nonce;
      const pending = new Set(this.others);
      const foreign = new Set<string>();
      let sameTabSeen = false;
      const decide = (verdict: TabVerdict) => {
        if (this.verdict) return;
        this.decide(verdict);
        resolve(verdict);
      };
      // Ends when every listed document answered or at the time-out. A "duplicate" verdict is
      // given at the first foreign answer; the rest only tells which ids to drop from the lease.
      const complete = () => {
        clearTimeout(timer);
        this.onCheckMessage = null;
        decide(foreign.size > 0 || !sameTabSeen ? 'duplicate' : 'kept');
        this.dropDocs(probe, [...foreign, ...pending]);
      };
      this.onCheckMessage = (message) => {
        if (message.type !== 'bye' && !(message.type === 'here' && message.nonce === nonce)) return;
        if (!pending.has(message.docId)) return;
        pending.delete(message.docId);
        // A document of this tab removes itself from this tab's lease before it says bye.
        const sameTab = message.type === 'here' ? message.sameTab === true : !this.listed(message.docId);
        if (sameTab) sameTabSeen = true;
        else {
          foreign.add(message.docId);
          decide('duplicate');
        }
        if (pending.size === 0) complete();
      };
      try {
        this.storage.setItem(probe, '1');
      } catch (error) {
        console.warn('[Undo] Could not check for a duplicated tab:', error);
        decide('kept');
        this.onCheckMessage = null;
        return;
      }
      const timer = setTimeout(complete, this.timeoutMs);
      this.post({ type: 'who', nonce, docs: this.others });
    });
    return this.checking;
  }

  /** Stop listening (tests; a real document's lease lives as long as the document). */
  dispose(): void {
    this.eventTarget?.removeEventListener('pagehide', this.onPageHide);
    this.eventTarget?.removeEventListener('pageshow', this.onPageShow);
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
  }

  private decide(verdict: TabVerdict) {
    this.verdict = verdict;
    if (verdict !== 'duplicate') return;
    try {
      // The first document of the duplicate to decide starts the new history; later ones see the
      // new tab id. (A tab id exists whenever a history does: the store makes it on start.)
      if (this.storage.getItem(UNDO_TAB_ID_KEY) === this.tabIdAtStart) {
        debug('Duplicated tab: starting a new undo history');
        removeAllHistories(this.storage);
        this.storage.setItem(UNDO_TAB_ID_KEY, randomId());
      }
    } catch (error) {
      console.warn('[Undo] Could not start a new undo history:', error);
    }
  }

  /** Drop documents of another tab (copied ids) and ones that never answered. */
  private dropDocs(probe: string, drop: string[]) {
    try {
      this.storage.removeItem(probe);
      writeDocs(this.storage, readDocs(this.storage).filter((id) => !drop.includes(id)));
    } catch (error) {
      console.warn('[Undo] Could not update the tab lease:', error);
    }
  }

  private listed(docId: string): boolean {
    try {
      return readDocs(this.storage).includes(docId);
    } catch {
      return false;
    }
  }

  private post(message: LeaseMessage) {
    try {
      this.channel?.postMessage(message);
    } catch (error) {
      console.warn('[Undo] Could not post on the lease channel:', error);
    }
  }

  private onMessage = (event: MessageEvent) => {
    const message = event.data as LeaseMessage | null;
    if (typeof message !== 'object' || message === null) return;
    if (message.type === 'who') {
      if (!this.live || !Array.isArray(message.docs) || !message.docs.includes(this.docId)) return;
      let sameTab = false;
      try {
        sameTab = this.storage.getItem(PROBE_PREFIX + String(message.nonce)) !== null;
      } catch {
        // cannot tell; "another tab" is the safe answer
      }
      this.post({ type: 'here', nonce: message.nonce, docId: this.docId, sameTab });
      return;
    }
    this.onCheckMessage?.(message);
  };

  private onPageHide = () => {
    if (!this.live) return;
    this.live = false;
    try {
      writeDocs(this.storage, readDocs(this.storage).filter((id) => id !== this.docId));
    } catch {
      // storage gone: nothing to release
    }
    this.post({ type: 'bye', docId: this.docId });
  };

  private onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted || this.live) return;
    try {
      writeDocs(this.storage, [...readDocs(this.storage), this.docId]);
      this.live = true;
    } catch {
      // storage gone: the history is not shared anyway
    }
  };
}

function sessionStorageOrNull(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** This document's lease in sessionStorage, registered at module start. */
const documentLease: TabLease | null = (() => {
  const storage = typeof window === 'undefined' ? null : sessionStorageOrNull();
  if (!storage) return null;
  try {
    return new TabLease({ storage });
  } catch {
    return null;
  }
})();

function isIdentity(value: unknown): value is StateIdentity {
  const v = value as StateIdentity | null;
  return typeof v === 'object' && v !== null && Number.isFinite(v.revision) && typeof v.writerId === 'string';
}

function isCheckpoint(value: unknown): value is UndoCheckpoint {
  const v = value as UndoCheckpoint | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.description === 'string' &&
    typeof v.timestamp === 'number' &&
    typeof v.before === 'object' &&
    v.before !== null &&
    Array.isArray(v.before.rows) &&
    isIdentity(v.after)
  );
}

function parseStack(raw: string | null): UndoCheckpoint[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isCheckpoint) ? parsed : [];
  } catch {
    return [];
  }
}

const isQuotaError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22);

/** True when `next` is `prev` with only a new revision / writerId (same content objects). */
function isRestamp(prev: EncounterState, next: EncounterState): boolean {
  const keys = Object.keys(next) as (keyof EncounterState)[];
  return (
    keys.length === Object.keys(prev).length &&
    keys.every((k) => k === 'revision' || k === 'writerId' || prev[k] === next[k])
  );
}

interface Pending {
  before: EncounterState;
  description: string;
  base: StateIdentity;
  /** True once the checkpoint was pushed; later local changes in the window move its `after`. */
  pushed: boolean;
}

export class LocalUndoStore {
  private readonly deps: UndoStoreDeps;
  private readonly storage: Storage;
  private readonly key: string;
  private readonly maxCheckpoints: number;

  private checkpoints: UndoCheckpoint[] = [];
  private pending: Pending | null = null;
  private restoring = false;
  private lastIdentity: StateIdentity;
  private lastState: EncounterState;
  private canUndoValue = false;
  private descriptionValue: string | null = null;

  private listeners = new Set<() => void>();
  private channel: UndoChannel | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private started = false;
  private generation = 0;
  private tabId: string | null = null;
  private readonly lease: TabLease | null;
  /** True while checking whether this tab is a duplicate; the stored history is not used. */
  private verifying = false;
  /** Resolves when the duplicate-tab check has ended. */
  ready: Promise<void> = Promise.resolve();

  constructor(deps: UndoStoreDeps) {
    this.deps = deps;
    this.storage = deps.storage ?? defaultStorage();
    this.key = `${UNDO_STORAGE_PREFIX}${deps.roomId || 'default'}`;
    this.maxCheckpoints = deps.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.lease =
      deps.lease !== undefined ? deps.lease : this.storage === sessionStorageOrNull() ? documentLease : null;
    this.lastState = this.current();
    this.lastIdentity = identityOf(this.lastState);
  }

  // ---------- lifecycle ----------

  /** Load the stack and start following the Redux store and other iframes. Idempotent. */
  start(): this {
    if (this.started) return this;
    this.started = true;
    this.removeLegacyEntries();
    this.removeOldEntries();
    this.openChannel();
    this.verifying = !!this.lease && this.lease.verdict === null;
    if (this.verifying) this.checkpoints = [];
    this.reload();
    this.lastState = this.current();
    this.lastIdentity = identityOf(this.lastState);
    this.unsubscribeStore = this.deps.store.subscribe(this.onStoreChange);
    this.eventTarget()?.addEventListener('storage', this.onStorage);
    this.refresh();
    if (this.verifying) this.ready = this.awaitVerdict(++this.generation);
    return this;
  }

  destroy(): void {
    this.generation++;
    this.verifying = false;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.eventTarget()?.removeEventListener('storage', this.onStorage);
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
    this.pending = null;
    this.started = false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------- public API ----------

  /**
   * Call right before dispatching the action(s) to undo later, in the same task. The
   * checkpoint is kept only if this iframe changes the state before the task ends.
   */
  captureCheckpoint(description: string): void {
    const state = this.current();
    const pending: Pending = {
      before: JSON.parse(JSON.stringify(state)) as EncounterState,
      description,
      base: identityOf(state),
      pushed: false,
    };
    this.pending = pending;
    queueMicrotask(() => {
      if (this.pending === pending) {
        if (!pending.pushed) debug('Dropped checkpoint without a change:', description);
        this.pending = null;
      }
    });
  }

  canUndo(): boolean {
    return this.canUndoValue;
  }

  getUndoDescription(): string | null {
    return this.descriptionValue;
  }

  /** Restore the top checkpoint if the room still holds the state it led to. */
  performUndo(): boolean {
    this.reload();
    const now = identityOf(this.current());
    const top = this.checkpoints[this.checkpoints.length - 1];
    const room = this.deps.getRoomIdentity?.() ?? null;
    // Same revision with another writer counts as newer: it is not the state Undo would replace.
    const newerInRoom = !!room && !!top && !sameIdentity(room, top.after) && room.revision >= top.after.revision;
    if (!top || !sameIdentity(top.after, now) || newerInRoom) {
      if (newerInRoom) debug('Not undoing: the room holds a newer state');
      this.refresh();
      return false;
    }
    // Storage is untrusted: restore only what the codec accepts (it also repairs it).
    const parsed = parseEncounterState(top.before);
    if (parsed.kind !== 'ok') {
      console.warn('[Undo] Dropped an undo history with an invalid snapshot');
      this.clearCheckpoints();
      return false;
    }
    this.pending = null;
    this.restoring = true;
    try {
      this.deps.store.dispatch(restoreSnapshot(parsed.state));
    } finally {
      this.restoring = false;
    }
    this.lastState = this.current();
    const restored = identityOf(this.lastState);
    this.lastIdentity = restored;
    this.checkpoints = this.checkpoints.slice(0, -1);
    const next = this.checkpoints[this.checkpoints.length - 1];
    // The restored content equals the state `next` led to; it now has a new identity.
    if (next) this.checkpoints[this.checkpoints.length - 1] = { ...next, after: restored };
    this.save();
    this.refresh();
    debug('Restored:', top.description, restored);
    return true;
  }

  /**
   * Remove the top checkpoint if it led to this iframe's current state and that state is
   * this iframe's own change. Used when a change will never reach the room (a modal whose
   * write failed is cancelled), so the shared history leads to the room state again.
   * `addedRowId`: remove it only if it is the checkpoint of that row's add (its snapshot does
   * not hold the row), not a newer one (e.g. a token add made since).
   * Returns true if a checkpoint was removed.
   */
  discardOwnTopCheckpoint(addedRowId?: string): boolean {
    this.reload();
    const now = identityOf(this.current());
    const top = this.checkpoints[this.checkpoints.length - 1];
    if (!top || now.writerId !== this.deps.writerId || !sameIdentity(top.after, now)) return false;
    if (addedRowId !== undefined && top.before.rows.some((row: unknown) => (row as { id?: unknown } | null)?.id === addedRowId)) return false; // untrusted storage
    this.pending = null;
    this.checkpoints = this.checkpoints.slice(0, -1);
    this.save();
    this.refresh();
    return true;
  }

  clearCheckpoints(): void {
    this.pending = null;
    this.checkpoints = [];
    this.save();
    this.refresh();
  }

  // ---------- internals ----------

  private current(): EncounterState {
    return this.deps.store.getState().swade;
  }

  private eventTarget() {
    if (this.deps.eventTarget !== undefined) return this.deps.eventTarget;
    return typeof window === 'undefined' ? null : window;
  }

  private onStoreChange = () => {
    const state = this.current();
    const now = identityOf(state);
    if (sameIdentity(now, this.lastIdentity)) return;
    const prev = this.lastIdentity;
    const prevState = this.lastState;
    this.lastIdentity = now;
    this.lastState = state;
    if (this.restoring) return; // handled by performUndo

    const rebase = rebaseOrigins.get(state);
    if (rebase) {
      this.pending = null;
      this.retarget(rebase.replaced, rebase.from, rebase.base, now);
    } else if (isRestamp(prevState, state)) {
      this.moveTop(prev, now);
    } else if (now.writerId === this.deps.writerId) {
      this.onLocalChange(prev, now);
    } else {
      // Adopted from the room (another iframe or client). Undo turns off in refresh()
      // unless this is the state the top checkpoint led to.
      this.pending = null;
      this.reload();
    }
    this.refresh();
  };

  /** Move the top checkpoint's `after` from `prev` to `now` (same content). */
  private moveTop(prev: StateIdentity, now: StateIdentity) {
    this.reload();
    const last = this.checkpoints.length - 1;
    const top = this.checkpoints[last];
    if (top && sameIdentity(top.after, prev)) {
      this.checkpoints[last] = { ...top, after: now };
      this.save();
    }
  }

  /** The local state `replaced` was rebased onto `base` as `now` (see rebaseOrigins). */
  private retarget(replaced: StateIdentity, from: StateIdentity | null, base: EncounterState, now: StateIdentity) {
    this.reload();
    const top = this.checkpoints[this.checkpoints.length - 1];
    if (!top || !from || !sameIdentity(top.after, replaced) || !sameIdentity(identityOf(top.before), from)) return;
    this.checkpoints = [{ ...top, before: JSON.parse(JSON.stringify(base)) as EncounterState, after: now }];
    this.save();
  }

  private onLocalChange(prev: StateIdentity, now: StateIdentity) {
    const pending = this.pending;
    if (!pending) return; // uncaptured change: the top no longer matches, so Undo turns off
    this.reload();
    const last = this.checkpoints.length - 1;
    if (pending.pushed) {
      this.moveTop(prev, now);
      return;
    }
    pending.pushed = true;
    // A stack whose top is not the state this action started from cannot be undone in
    // order any more; start a new history.
    const top = this.checkpoints[last];
    if (top && !sameIdentity(top.after, pending.base)) this.checkpoints = [];
    this.checkpoints = [
      ...this.checkpoints,
      { before: pending.before, description: pending.description, after: now, timestamp: Date.now() },
    ].slice(-this.maxCheckpoints);
    this.save();
    debug('Captured:', pending.description, now);
  }

  private onStorage = (event: StorageEvent) => {
    // A sibling iframe found that this tab is a duplicate and took a new tab id.
    if (event.key === UNDO_TAB_ID_KEY) return this.joinTabId();
    if (event.key !== null && event.key !== this.key) return;
    this.reload();
    this.refresh();
  };

  private onChannelMessage = (event: MessageEvent) => {
    if (event.data !== this.key) return;
    this.reload();
    this.refresh();
  };

  /** Join this tab's channel (name scoped by a per-tab id in the session storage). */
  private openChannel() {
    const factory = this.deps.channel === undefined ? defaultChannel : this.deps.channel;
    if (!factory) return;
    try {
      let tabId = this.storage.getItem(UNDO_TAB_ID_KEY);
      if (!tabId) {
        tabId = randomId();
        this.storage.setItem(UNDO_TAB_ID_KEY, tabId);
      }
      if (this.channel) {
        this.channel.onmessage = null;
        this.channel.close();
      }
      this.tabId = tabId;
      this.channel = factory(`swade-undo:${tabId}`);
      if (this.channel) this.channel.onmessage = this.onChannelMessage;
    } catch (error) {
      console.warn('[Undo] Could not open the undo channel:', error);
      this.channel = null;
    }
  }

  /** Wait for this document's lease check (see the header comment), then use the stored history. */
  private async awaitVerdict(generation: number) {
    await this.lease!.check();
    if (generation !== this.generation) return;
    this.verifying = false;
    this.joinTabId();
    this.reload();
    this.refresh();
  }

  /** Re-join the tab's channel if the tab id changed (a duplicate takes a new one). */
  private joinTabId() {
    if (!this.started || !this.tabId) return;
    try {
      if (this.storage.getItem(UNDO_TAB_ID_KEY) !== this.tabId) this.openChannel();
    } catch {
      // keep the current channel
    }
  }

  private post(message: unknown) {
    try {
      this.channel?.postMessage(message);
    } catch (error) {
      console.warn('[Undo] Could not notify other iframes:', error);
    }
  }

  /** Tell sibling iframes of this tab to re-read the stack. */
  private notify() {
    this.post(this.key);
  }

  private refresh() {
    const top = this.checkpoints[this.checkpoints.length - 1];
    const canUndo = !!top && sameIdentity(top.after, identityOf(this.current()));
    const description = canUndo && top ? top.description : null;
    if (canUndo === this.canUndoValue && description === this.descriptionValue) return;
    this.canUndoValue = canUndo;
    this.descriptionValue = description;
    for (const listener of [...this.listeners]) listener();
  }

  private reload() {
    if (this.verifying) return; // keep the in-memory stack until the check ends
    try {
      this.checkpoints = parseStack(this.storage.getItem(this.key));
    } catch (error) {
      console.warn('[Undo] Could not read undo history:', error);
    }
  }

  private save() {
    if (this.verifying) return;
    try {
      if (this.checkpoints.length === 0) this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, JSON.stringify(this.checkpoints));
      this.notify();
      return;
    } catch (error) {
      if (!isQuotaError(error)) {
        console.warn('[Undo] Could not save undo history:', error);
        return;
      }
    }
    for (const count of [10, 5, 2, 1]) {
      try {
        this.checkpoints = this.checkpoints.slice(-count);
        this.storage.setItem(this.key, JSON.stringify(this.checkpoints));
        this.notify();
        return;
      } catch {
        // try a smaller history
      }
    }
    console.warn('[Undo] Storage full; undo history not saved');
  }

  /**
   * Remove the histories of older versions from localStorage (v1 and v2 keys). They are
   * shared by all tabs of the browser, so they may hold another tab's actions: never import them.
   */
  private removeLegacyEntries() {
    const legacy = this.deps.legacyStorage === undefined ? defaultLegacyStorage() : this.deps.legacyStorage;
    if (!legacy || legacy === this.storage) return;
    try {
      const remove: string[] = [];
      for (let i = 0; i < legacy.length; i++) {
        const key = legacy.key(i);
        if (key?.startsWith(LEGACY_PREFIX)) remove.push(key);
      }
      for (const key of remove) legacy.removeItem(key);
    } catch (error) {
      console.warn('[Undo] Could not remove old undo histories:', error);
    }
  }

  /** Remove other rooms' histories (in this tab's storage) older than MAX_AGE_MS. */
  private removeOldEntries() {
    try {
      const now = Date.now();
      const remove: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (!key?.startsWith(UNDO_STORAGE_PREFIX) || key === this.key) continue;
        const stack = parseStack(this.storage.getItem(key));
        const newest = stack[stack.length - 1];
        if (!newest || now - newest.timestamp > MAX_AGE_MS) remove.push(key);
      }
      for (const key of remove) this.storage.removeItem(key);
    } catch (error) {
      console.warn('[Undo] Could not clean up old undo histories:', error);
    }
  }
}
