// Sync engine: keeps one iframe's Redux store and the room metadata key in step.
//
// Rules (see docs/owlbear-platform.md §6 and §17):
// - The room holds one key. Room metadata is last-write-wins with no compare-and-set.
// - A state is identified by (revision, writerId). Local changes are stamped centrally
//   (createAppStore) with max(local, seen) + 1 and this iframe's writerId.
// - Model: `acked` is the newest identity known to be in the room from our side (our last
//   successful write, or the last adopted state). The local state is dirty when it is an
//   own change (our writerId) whose identity is not `acked`.
// - Rebase (no GM action is lost to a concurrent write): the engine keeps a log of its own
//   local actions. Each written state stores its `parent`, the room state it was derived
//   from; with it every engine knows which of its actions a room state includes. A room
//   state that misses some of them is followed by replaying those actions on top of it (a
//   new own state, written). With unknown lineage (missed events) the engine first checks
//   which actions the state already includes (presentSeq). When a replay is impossible (that
//   check fails, an Undo restore, or this client may not write), the room state is adopted;
//   the GM gets one warning when an unsaved own change is discarded that way. Discarded actions
//   leave the log (never replayed).
// - Turn navigation (Next / Previous, Start Round) records the turn position it was made on
//   (`from`). It is replayed only onto a room state on that same position (nobody moved the turn
//   since) whose target can take a turn; otherwise it is dropped silently. It never warns, never
//   counts in the presence check, and cannot apply twice (after it applies, the position moved).
// - Inbound: room events arrive in room order, so the last event is the room value. The
//   local state follows it (rebased as above), unless it is an older echo of our own (our
//   newer state is already written or coming). While a write is coming, a foreign state is
//   only recorded: the write loop rebases onto it before it writes. An echo of the local
//   state acks it; if it comes after a foreign state that we did not follow, our write
//   overwrote that state, so we rebase onto it too (its writer may be gone, e.g. a modal).
//   An event that leaves our key unchanged changes nothing (a too-large state is re-tried,
//   as other keys may have freed space). Invalid data or a newer version's state is never
//   overwritten by a pending own change: the change is discarded (warning) and the status set.
// - Missed events: the room is read once when the iframe wakes (visible again, focus,
//   online) and ECHO_WAIT_MS after a write attempt whose echo did not arrive. No polling.
// - Revisions: states are stamped above every revision seen in the room, written by this
//   iframe or held locally (so an identity is never reused). A rebased state is stamped
//   above the state it was rebased onto, so the room's revision rises again after a
//   concurrent write.
// - Outbound: GMs only (checked before every attempt), one serial write loop, debounced:
//   while dirty, write the newest local state; retry with backoff on RateLimitHit /
//   timeouts. If another value arrived during a write and our echo did not (events
//   can be late or coalesced), the order is unknown: we rebase onto a foreign state (and
//   read the room once if it was adopted), else write the same content again. On a role
//   change, a client that may no longer write follows the room.
// - Never write before the initial read succeeded, and never after a read failed.
// - The plugin id / metadata key is kept as is (changing it would orphan existing rooms).
// - Mixed app versions: each write stores the app version and SYNC_PROTOCOL (`client`). A
//   state of a higher protocol is handled like a newer state version (too-new: not adopted,
//   not written over, reload notice). A state without `client` after protocol-aware ones
//   means an older app wrote it: the GM is told once.

import type { Metadata } from '@owlbear-rodeo/sdk';
import type { UnknownAction } from '@reduxjs/toolkit';
import type { EncounterState, StateIdentity } from './types';
import { getPluginId } from '../getPluginId';
import { encodeEncounterState, measureJsonBytes, parseEncounterState, type ClientInfo, type ParseResult } from './stateCodec';
import { initializeEmptyState } from './initialState';
import { canTakeTurn, createParticipant, removeParticipant, restoreSnapshot, selectKeeperCard, setActiveParticipant, setEncounterState, startRound, swadeSlice } from './swadeSlice';
import { version as packageVersion } from '../../package.json';

export const STATE_KEY = getPluginId('state');

/**
 * Sync protocol of this engine: how states, lineage and replay are read and written. Raise it
 * by one whenever an older engine would merge or replay a newer engine's states wrongly; a
 * client that sees a higher one treats the room like a newer state version (reload needed).
 */
export const SYNC_PROTOCOL = 1;
/** App version (package.json), stored with every write. */
export const APP_VERSION: string = packageVersion;
/** Stored with every write (`client`). */
const CLIENT_INFO: ClientInfo = APP_VERSION ? { syncProtocol: SYNC_PROTOCOL, appVersion: APP_VERSION } : { syncProtocol: SYNC_PROTOCOL };

/**
 * Parse a stored value; a state written with a higher sync protocol is `too-new` (this engine
 * would merge it wrongly).
 */
export function parseRoomValue(raw: unknown): ParseResult {
  const result = parseEncounterState(raw);
  return result.kind === 'ok' && result.client && result.client.syncProtocol > SYNC_PROTOCOL ? { kind: 'too-new' } : result;
}

/** Room metadata limit shared by all extensions in a room. */
export const ROOM_LIMIT_BYTES = 16384;
/** Headroom kept free below the room limit. */
export const SAFETY_BYTES = 512;
/** Above this size the GM gets a warning. */
export const WARN_BYTES = 10240;
/** Waits between attempts after a failed read or a retryable write failure. */
export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];
/** Write attempts before giving up (status `error`). */
export const MAX_WRITE_ATTEMPTS = 4;
/** Own actions kept for replay. A room state that misses an older one has unknown lineage. */
const MAX_LOGGED_ACTIONS = 50;
/** Room states whose lineage is remembered (a child names its parent). */
const MAX_LINEAGE = 200;
/** After a write attempt whose echo has not arrived, read the room once after this wait. */
export const ECHO_WAIT_MS = 5000;

export type SyncStatus =
  | 'loading' // initial read not done yet (or retrying)
  | 'ready'
  | 'absent-player' // no state in the room; players show an empty tracker
  | 'invalid' // room holds data that cannot be parsed
  | 'too-new' // room holds a newer state version: reload needed
  | 'error' // initial read keeps failing, or a write failed after retries
  | 'too-large'; // state is over the room size budget and was not written

export interface SyncSnapshot {
  status: SyncStatus;
  /** True once the room state was read (or received) at least once. */
  loaded: boolean;
  /** Encoded size of the last state checked for writing. */
  bytes: number;
  /** True while that size is above WARN_BYTES. */
  nearLimit: boolean;
}

/** The part of the OBR SDK the engine uses (OBR itself, or a test client). */
export interface SyncObr {
  room: {
    getMetadata(): Promise<Metadata>;
    setMetadata(update: Partial<Metadata>): Promise<void>;
    onMetadataChange(callback: (metadata: Metadata) => void): () => void;
  };
  notification: {
    show(message: string, variant?: 'DEFAULT' | 'ERROR' | 'INFO' | 'SUCCESS' | 'WARNING'): Promise<string>;
  };
}

export interface SyncStore {
  getState(): { swade: EncounterState };
  dispatch(action: UnknownAction): unknown;
  subscribe(listener: () => void): () => void;
  /** Local actions that changed the state (createAppStore); needed to rebase concurrent changes. */
  subscribeActions?(listener: (action: UnknownAction, before: EncounterState) => void): () => void;
}

export interface SyncEngineOptions {
  store: SyncStore;
  obr: SyncObr;
  writerId: string;
  isGm: () => boolean;
  /** Calls the listener when the role (isGm) may have changed; returns an unsubscribe function. */
  subscribeRole?: (listener: () => void) => () => void;
  /**
   * Calls the listener when room events may have been missed (the iframe became visible
   * again, got focus, or the browser came back online); the engine then reads the room once.
   */
  subscribeWake?: (listener: () => void) => () => void;
  debounceMs?: number;
  /**
   * Test hook: called when an own logged action is replayed with an effect onto the room state
   * `on` (`replayed`), or an own turn navigation is dropped on a replay onto it (`dropped`).
   */
  onTrace?: (event: SyncTrace) => void;
}

export interface SyncTrace {
  kind: 'dropped' | 'replayed';
  action: UnknownAction;
  on: Identity;
  /** The state the action was checked on: `on` with the earlier replayed actions. */
  state: EncounterState;
}

export interface SyncEngine {
  /** Subscribe and load. Safe to call more than once (returns the same promise). */
  start(): Promise<void>;
  /**
   * Cancel the debounce, write now if needed, and wait for the write loop. Resolves to
   * true when the local state is saved in the room (or there was no local change), false
   * when it is not: the write failed or was too large, or this client may not write.
   */
  flush(): Promise<boolean>;
  /**
   * Retry a write that failed (status `error`) or was too large (`too-large`):
   * re-queue the newest local state. GM only; no-op in any other status.
   */
  retry(): Promise<void>;
  stop(): void;
  getSnapshot(): SyncSnapshot;
  subscribe(listener: () => void): () => void;
  /** Highest revision seen in the room or written by this iframe; local changes are stamped above it. */
  getMaxSeenRevision(): number;
  /** Identity of the newest state seen in the room (adopted or not), or null. */
  getRoomIdentity(): Identity | null;
}

export type Identity = StateIdentity;

const sameIdentity = (a: Identity | null, b: Identity | null) =>
  a !== null && b !== null && a.revision === b.revision && a.writerId === b.writerId;

const identityOf = (state: EncounterState): Identity => ({ revision: state.revision, writerId: state.writerId });

/** One own local action, kept for replay on a concurrent foreign state (see rebase). */
interface LoggedAction {
  seq: number;
  action: UnknownAction;
  /** Identity of the local state the action was applied to. */
  before: Identity | null;
  /** Revision of the first written state that included it. */
  sentRevision?: number;
  /** Turn navigation only (Next / Previous, Start Round): the turn position it was made on. */
  from?: string;
}

/**
 * A rebased local state → what it replaced. The undo store moves its top checkpoint onto
 * the new base when that checkpoint covers exactly the replayed actions (`from` is the
 * state they started from), so Undo restores `base` and keeps the foreign change.
 */
export const rebaseOrigins = new WeakMap<EncounterState, { replaced: Identity; from: Identity | null; base: EncounterState }>();

/** Parent of a state made in a room without state: derived from nothing (a fresh root). */
const NO_PARENT: Identity = { revision: 0, writerId: '' };

const OLDER_CLIENT_WARNING = 'Initiative tracker: another player or GM uses an older version. Ask them to reload the page.';
const REPLACED_WARNING = 'Initiative tracker: a change in the room may have replaced your last change.';
const DISCARDED_WARNING = 'Initiative tracker: the encounter changed in the room. Your unsaved change was discarded.';

/**
 * Whether a replayed action that changes nothing on `state` has its intent met there, so
 * dropping it is right. Logged actions changed the state when first applied. A keeper choice
 * whose card is not among the row's candidates any more (e.g. its draw was replayed and dealt
 * another card) is lost. The slice's other actions set a target value, or act on a row, phase
 * or turn that another GM's change already handled (removed, dealt, advanced).
 */
function intentMet(action: UnknownAction, state: EncounterState): boolean {
  if (selectKeeperCard.match(action)) {
    const row = state.rows.find((r) => r.id === action.payload.participantId);
    return !row || (row.currentCardId === action.payload.cardId && row.candidateIds.length === 1);
  }
  return action.type.startsWith(`${swadeSlice.name}/`);
}

/**
 * The row a slice action acts on, when a missing row makes it a no-op. Not for an add (it brings
 * the row) nor a removal (a missing row is its intent).
 */
function targetRow(action: UnknownAction): string | null {
  if (createParticipant.match(action) || removeParticipant.match(action)) return null;
  const payload = (action as { payload?: unknown }).payload;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const { participantId, id } = payload as { participantId?: unknown; id?: unknown };
  const row = participantId ?? id;
  return typeof row === 'string' ? row : null;
}

/** Where the turn is: round, phase and active row. */
const turnPosition = (state: EncounterState) => `${state.round}|${state.phase}|${state.turn.activeRowId ?? ''}`;

/** Turn navigation: Next / Previous (setActiveParticipant) or Start Round. */
const isNavigation = (action: UnknownAction) => startRound.match(action) || setActiveParticipant.match(action);

/**
 * Replay a turn navigation onto `state`: only on the position it was made on, with a target that
 * can take a turn. Returns `state` itself when it does not apply (the caller drops it).
 */
function replayNavigation(entry: LoggedAction, state: EncounterState): EncounterState {
  if (turnPosition(state) !== entry.from) return state;
  const { action } = entry;
  if (setActiveParticipant.match(action) && action.payload !== null) {
    const row = state.rows.find((r) => r.id === action.payload);
    if (!row || !canTakeTurn(row)) return state;
  }
  return swadeSlice.reducer(state, action);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** RateLimitHit (host error payload) or an SDK timeout (plain Error). */
export function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { error?: { name?: unknown } }).error?.name;
  if (name === 'RateLimitHit') return true;
  return error instanceof Error && /took longer than/i.test(error.message);
}

export function createSyncEngine({ store, obr, writerId, isGm, subscribeRole, subscribeWake, debounceMs = 50, onTrace }: SyncEngineOptions): SyncEngine {
  let snapshot: SyncSnapshot = { status: 'loading', loaded: false, bytes: 0, nearLimit: false };
  const listeners = new Set<() => void>();

  let lastResult: ParseResult | null = null; // last room value seen (read or event), in room order
  let lastSeen: Identity | null = null; // identity of that value, if it is a state
  let maxSeenRevision = 0;
  /** Highest revision this iframe sent; stamping stays above it so identities are unique. */
  let maxWrittenRevision = 0;
  let otherKeysBytes = 0;
  /** Room events received; a read is stale when an event arrived while it was pending. */
  let eventCount = 0;
  /** Newest state known to be in the room from this iframe's side (written or adopted). */
  let acked: Identity | null = null;
  /**
   * An own change given up with the discard warning: it is not written, and the room is followed.
   * Kept as the state object: its identity was never written, so a later state can reuse it.
   */
  let discarded: EncounterState | null = null;
  /**
   * The write in flight, and what arrived while it was in flight. `discardUnlessEchoed`: the
   * room got a value that the state must not overwrite (invalid, too-new) while this write
   * carried it; the change counts as discarded unless the write's echo arrives.
   */
  let inFlight: { id: Identity; echoed: boolean; otherBeforeEcho: boolean; discardUnlessEchoed: boolean } | null = null;
  /** The last write attempt whose echo has not arrived yet, and the timer that reads the room for it. */
  let echoWait: { id: Identity; timer: ReturnType<typeof setTimeout> } | null = null;
  /** A wake read in progress (one at a time). */
  let wakeRead: Promise<void> | null = null;
  /** Identities of write attempts reported as failed (other than RateLimitHit): the host may still apply them. */
  const failedAttempts = new Set<string>();
  const idKey = (id: Identity) => `${id.revision}/${id.writerId}`;
  const mayLandLate = (id: Identity) => failedAttempts.has(idKey(id));

  // ---- rebase state ----
  /** Own local actions, oldest first (bounded). */
  let log: LoggedAction[] = [];
  let lastSeq = 0;
  /** Newest own action seq that reached the room (a write that succeeded or echoed). */
  let savedSeq = 0;
  /** Newest seq dropped from the full log: a room state that misses it cannot be rebased. */
  let trimmedSeq = 0;
  /** Newest seq the room held before its key was last seen deleted: a fresh root counts as including it. */
  let rootSeq = 0;
  /** Room states and own writes → the newest own action seq they include (bounded, oldest first). */
  const lineage = new Map<string, number>();
  /** The last foreign room state that the local state follows (adopted or rebased onto). */
  let followed: Identity | null = null;
  /**
   * A room event carried a state with a stored `client`. Events arrive in room order, so a state
   * without it that arrives later was written later, by an older app. (Reads do not count: a
   * read can be ahead of events still on their way, which may carry older states.)
   */
  let clientEventSeen = false;
  let olderClientNotified = false;

  let internalDispatch = false;
  let lastStoreState = store.getState().swade;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<void> = Promise.resolve();
  let scheduled = 0; // write loops queued or running

  let warned = false;
  let tooLargeNotified = false;
  let startPromise: Promise<void> | null = null;
  let stopped = false;
  const unsubscribers: (() => void)[] = [];

  const debug = (...args: unknown[]) => {
    if (import.meta.env.DEV && import.meta.env.MODE !== 'test') console.debug('[sync]', ...args);
  };

  function setSnapshot(patch: Partial<SyncSnapshot>) {
    const next = { ...snapshot, ...patch };
    if ((Object.keys(next) as (keyof SyncSnapshot)[]).every((k) => next[k] === snapshot[k])) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function notify(message: string, variant: 'ERROR' | 'WARNING') {
    obr.notification.show(message, variant).catch(() => {});
  }

  const local = (): EncounterState => store.getState().swade;
  /** Above every revision seen, written or held locally: an engine stamp never reuses an identity. */
  const nextRevision = () => Math.max(maxSeenRevision, maxWrittenRevision, local().revision) + 1;

  function dispatchInternal(state: EncounterState) {
    internalDispatch = true;
    try {
      store.dispatch(setEncounterState(state));
    } finally {
      internalDispatch = false;
      lastStoreState = local();
    }
  }

  const canWrite = () => snapshot.loaded && snapshot.status !== 'too-new' && isGm() && !stopped;
  /** A foreign room state arrived that the local state does not follow yet. */
  const foreignPending = () =>
    lastResult?.kind === 'ok' && lastSeen!.writerId !== writerId && !sameIdentity(lastSeen, followed);
  /** The local state is an own change that the room does not hold yet. */
  const dirty = () => local().writerId === writerId && !sameIdentity(identityOf(local()), acked) && local() !== discarded;
  /** A debounce or write loop is pending: the newest local state will still be written. */
  const busy = () => timer !== null || scheduled > 0;
  const failed = () => snapshot.status === 'error' || snapshot.status === 'too-large';

  // ---------- inbound ----------

  function record(metadata: Metadata, event = false) {
    const { [STATE_KEY]: raw, ...others } = metadata;
    otherKeysBytes = measureJsonBytes(others);
    const previous = lastSeen;
    lastResult = parseRoomValue(raw);
    lastSeen = lastResult.kind === 'ok' ? identityOf(lastResult.state) : null;
    if (lastSeen) maxSeenRevision = Math.max(maxSeenRevision, lastSeen.revision);
    if (lastResult.kind === 'ok') {
      noteClient(lastResult.client, event);
      // Room order: a parent is recorded before its children.
      const included = includedSeq(lastResult.state, lastResult.parent);
      if (included !== null) remember(lastSeen!, included);
    } else if (lastResult.kind === 'absent' && previous) {
      // The key was deleted: what the room held is reset.
      rootSeq = Math.max(rootSeq, lineage.get(idKey(previous)) ?? 0);
    }
  }

  /** An older app wrote a state after a protocol-aware one: tell the GM once. */
  function noteClient(client: ClientInfo | null, event: boolean) {
    if (client) clientEventSeen ||= event;
    else if (clientEventSeen && !olderClientNotified && isGm()) {
      olderClientNotified = true;
      notify(OLDER_CLIENT_WARNING, 'WARNING');
    }
  }

  // ---------- rebase ----------

  function logAction(action: UnknownAction, before?: EncounterState) {
    if (internalDispatch) return;
    const entry: LoggedAction = { seq: ++lastSeq, action, before: before ? identityOf(before) : null };
    if (before && isNavigation(action)) entry.from = turnPosition(before);
    log.push(entry);
    if (log.length > MAX_LOGGED_ACTIONS) trimmedSeq = log.shift()!.seq;
  }

  function remember(id: Identity, seq: number) {
    const key = idKey(id);
    lineage.delete(key);
    lineage.set(key, seq);
    if (lineage.size > MAX_LINEAGE) lineage.delete(lineage.keys().next().value!);
  }

  /**
   * The newest own action seq that a room state includes, or null when that is unknown.
   * Known from its own identity (our writes) or its parent's. A fresh root (parent NO_PARENT)
   * counts as including the actions the room held when its key was deleted: replaying those
   * would undo the reset. Later ones (also those made before this engine saw the deletion)
   * are replayed.
   * An older app version's state at revision 0 (no parent) includes every saved action.
   * Otherwise the state was derived from a state at or below its parent's revision (without
   * a parent, an older app version or a copied parent: below its own revision), and a
   * descendant always has a higher revision than its ancestor, so it includes no action
   * first written above that; one written at or below it may be included (unknown).
   * After a key deletion, the actions the room held then (rootSeq) always count as included.
   * Unknown too when it misses an unsaved action that was dropped from the full log.
   */
  function includedSeq(state: EncounterState, parent: Identity | null): number | null {
    let seq: number | null = lineage.get(idKey(identityOf(state))) ?? (parent ? lineage.get(idKey(parent)) : undefined) ?? null;
    if (seq === null && sameIdentity(parent, NO_PARENT)) seq = rootSeq;
    else if (seq === null && !parent && state.revision === 0) seq = Math.max(rootSeq, savedSeq);
    else if (seq === null) {
      const bound = parent ? parent.revision : state.revision - 1;
      const firstAbove = log.find((entry) => entry.sentRevision === undefined || entry.sentRevision > bound);
      const maybe = firstAbove ? firstAbove.seq - 1 : lastSeq;
      // Actions the room held when its key was deleted count as included (as for a fresh
      // root): a state seen after a reset never brings them back.
      if (!log.some((entry) => entry.seq <= maybe && entry.seq > rootSeq)) seq = Math.max(maybe, rootSeq);
    }
    return seq !== null && seq < trimmedSeq && trimmedSeq > savedSeq ? null : seq;
  }

  /**
   * A room state of unknown lineage (events were missed): which of our logged actions does it
   * include? Replays the log (after rootSeq) on it without changing anything. Actions before
   * the first one whose replay changes the state are present (their replay is a no-op with
   * its intent met). From that one on, every action whose replay changes the state must be
   * unsent: never written, so no room state can hold it or have removed it on purpose; those
   * are missing and the caller replays them. A saved action whose replay changes the state is
   * never re-applied: another GM may have reversed it on purpose (e.g. removed our added row),
   * so the caller adopts the state with the warning. A saved content action that is a no-op only
   * because its row is gone (e.g. a rename of a removed row) is no evidence that the state holds
   * it: the caller warns. Turn navigation is not checked (it neither confirms nor warns); an
   * unsaved one only keeps the result below it, so the caller replays it. Returns the newest
   * included seq (remembered for the state, so its children are known), or null (the caller
   * warns): a saved action that the state does not show, a lost intent, a failing replay, or an
   * unsaved action dropped from the full log.
   */
  function presentSeq(room: EncounterState): number | null {
    if (trimmedSeq > savedSeq) return null;
    let state = room;
    let firstChanged: LoggedAction | null = null;
    try {
      for (const entry of log.filter((e) => e.seq > rootSeq)) {
        const saved = entry.sentRevision !== undefined;
        if (entry.from !== undefined) {
          if (!saved) firstChanged ??= entry;
          continue;
        }
        const next = swadeSlice.reducer(state, entry.action);
        if (next === state) {
          if (!intentMet(entry.action, state)) return null;
          const row = targetRow(entry.action);
          if (saved && row !== null && !state.rows.some((r) => r.id === row)) return null;
          continue;
        }
        // A saved content change that the state does not show: the caller warns.
        if (saved) return null;
        firstChanged ??= entry;
        state = next;
      }
    } catch (error) {
      debug('presence check failed', error);
      return null;
    }
    const seq = Math.max(rootSeq, firstChanged ? firstChanged.seq - 1 : lastSeq);
    remember(identityOf(room), seq);
    return seq;
  }

  /**
   * Replay `entries` on `base`; drops no-op entries from the log (unless `keepNoOps`). Null
   * when not possible. Turn navigation is replayed only where `replayNavigation` applies it (its
   * turn position unchanged, its target able to take a turn); otherwise it is dropped silently and
   * leaves the log (also with `keepNoOps`). `lost`: a content entry changed nothing on `base`
   * although its intent is not met there (intentMet); the caller warns the GM instead of a silent
   * drop. `held`: the content entries `base` holds (no-ops).
   */
  function replay(base: EncounterState, entries: LoggedAction[], keepNoOps = false): { state: EncounterState; lost: boolean; held: Set<LoggedAction> } | null {
    // An Undo restores a whole snapshot: over a foreign change it would erase that change.
    if (entries.some((entry) => restoreSnapshot.match(entry.action))) return null;
    let state = base;
    let lost = false;
    const noOps = new Set<LoggedAction>();
    const dropped = new Set<LoggedAction>();
    const trace = (kind: SyncTrace['kind'], entry: LoggedAction) => onTrace?.({ kind, action: entry.action, on: identityOf(base), state });
    try {
      for (const entry of entries) {
        if (entry.from !== undefined) {
          const next = replayNavigation(entry, state);
          if (next === state) {
            dropped.add(entry);
            trace('dropped', entry);
            continue;
          }
          trace('replayed', entry);
          state = next;
          continue;
        }
        const next = swadeSlice.reducer(state, entry.action);
        if (next === state) {
          // A row that is already there is not added twice (createParticipant is idempotent).
          noOps.add(entry);
          if (!intentMet(entry.action, state)) lost = true;
          continue;
        }
        trace('replayed', entry);
        state = next;
      }
    } catch (error) {
      debug('replay failed', error);
      return null;
    }
    log = log.filter((entry) => !dropped.has(entry) && (keepNoOps || !noOps.has(entry)));
    return { state, lost, held: noOps };
  }

  /** Drop turn navigation entries that are not replayed onto `room` (silently). */
  function drop(entries: LoggedAction[], room: EncounterState) {
    if (!entries.length) return;
    log = log.filter((entry) => !entries.includes(entry));
    for (const entry of entries) onTrace?.({ kind: 'dropped', action: entry.action, on: identityOf(room), state: room });
  }

  /**
   * Follow a room state: adopt it, with our actions that it does not include replayed on
   * top (a new own state, written). If they cannot be replayed, adopt it with one warning:
   * that an unsaved change was discarded, or (nothing unsaved) that a saved one may be gone.
   * `overwritten`: our write landed after it, so the room holds our state without its change:
   * write it with our actions on top (also when none is missing), or else leave the room as
   * it is (its writer replays its change on ours).
   */
  function rebase(room: EncounterState, parent: Identity | null, overwritten = false) {
    const known = includedSeq(room, parent);
    const included = known ?? presentSeq(room);
    // Unknown lineage: saved actions come before unsaved ones, so a saved turn navigation is always
    // counted as included (never applied again); an unsaved one is replayed by the rule.
    const missing = log.filter((entry) => entry.seq > (included ?? 0));
    // After a presence check, a no-op replay only shows that this state holds the action; a
    // state of another branch may not: the action stays in the log.
    const replayed =
      (missing.length || overwritten) && included !== null && canWrite() ? replay(room, missing, known === null) : null;
    const rebased = replayed?.state ?? null;
    if (replayed?.lost) notify(REPLACED_WARNING, 'WARNING');
    // The room state holds the missing actions it already shows (no-ops): its children do not
    // get them replayed.
    if (replayed) {
      const first = missing.findIndex((entry) => !replayed.held.has(entry));
      const holds = first === -1 ? missing.length : first;
      if (holds) remember(identityOf(room), missing[holds - 1].seq);
    }
    if (overwritten && !rebased) return;
    // Turn navigation that is not replayed is dropped silently.
    if (!rebased) drop(missing.filter((entry) => entry.from !== undefined), room);
    if (missing.some((entry) => entry.from === undefined) && !rebased) {
      if (dirty()) discardLocal();
      else {
        // Our actions are saved, but this state may not include them (unknown lineage) and its
        // writer may not repair that (e.g. events coalesced there too).
        notify(REPLACED_WARNING, 'WARNING');
        log = [];
      }
    }
    if (!rebased || (rebased === room && !overwritten)) {
      apply({ kind: 'ok', state: room, parent, client: null }); // apply does not read `client`
      return;
    }
    debug('rebase', missing.length, 'actions onto', identityOf(room));
    const next = { ...rebased, revision: nextRevision(), writerId };
    rebaseOrigins.set(next, { replaced: identityOf(local()), from: missing[0]?.before ?? null, base: room });
    // The replayed actions now start from `room` (for a later rebase's undo re-targeting).
    const kept = log.filter((entry) => entry.seq > included!);
    if (kept.length) kept[0].before = identityOf(room);
    if (inFlight && local() === discarded) inFlight.discardUnlessEchoed = false; // its actions are replayed
    dispatchInternal(next);
    acked = identityOf(room);
    if (room.writerId !== writerId) followed = acked;
    if (!failed()) setSnapshot({ status: 'ready', loaded: true });
    if (!busy()) void kick();
  }

  /** Make the local store follow a room value. */
  function apply(result: ParseResult) {
    switch (result.kind) {
      case 'ok':
        // The initial empty state (0/"") is replaced even by a room state with that identity.
        if (sameIdentity(identityOf(local()), NO_PARENT) || !sameIdentity(identityOf(local()), identityOf(result.state))) {
          debug('adopt', identityOf(result.state));
          dispatchInternal(result.state);
        }
        acked = identityOf(result.state);
        if (result.state.writerId !== writerId) followed = acked;
        setSnapshot({ status: 'ready', loaded: true });
        return;
      case 'absent':
        if (isGm()) {
          // A fresh local state; it becomes the room state once written.
          dispatchInternal({ ...initializeEmptyState(), revision: nextRevision(), writerId });
          setSnapshot({ status: 'ready', loaded: true });
          void kick();
        } else {
          dispatchInternal(initializeEmptyState());
          setSnapshot({ status: 'absent-player', loaded: true });
        }
        return;
      case 'invalid':
      case 'too-new':
        setSnapshot({ status: result.kind, loaded: true });
        return;
    }
  }

  /** Follow the last room value unless an own change is still going to be written over it. */
  function follow() {
    if (!lastResult) return;
    if (lastResult.kind === 'ok') {
      // A write is coming: the write loop rebases onto this state before it writes.
      if (dirty() && canWrite() && busy()) return;
      rebase(lastResult.state, lastResult.parent);
      return;
    }
    if (dirty()) {
      // The key was deleted (a reset, e.g. by a released v1 GM): keep the reset, with our
      // unsaved actions on a fresh state.
      if (lastResult.kind === 'absent' && canWrite() && (busy() || !failed()) && restartAfterDeletion()) return;
      // Invalid data or a newer app version's state: a pending change is not written over it.
      if (timer) clearTimeout(timer);
      timer = null;
      discardLocal(lastResult.kind !== 'absent');
    }
    apply(lastResult);
  }

  /**
   * Give up the unsaved local change: it is not written, a later room state is adopted (also
   * an older one of ours), and its actions are never replayed. The GM gets one warning.
   * `kept`: the local state stays (invalid data, a newer version); if the write in flight
   * carries exactly this state, its echo may still show that it landed last: then the warning
   * waits until the write ends without that echo.
   */
  function discardLocal(kept = false) {
    discarded = local();
    if (kept && inFlight && !inFlight.echoed && sameIdentity(inFlight.id, identityOf(discarded))) inFlight.discardUnlessEchoed = true;
    else warnDiscarded();
  }

  function warnDiscarded() {
    log = [];
    notify(DISCARDED_WARNING, 'WARNING');
  }

  /**
   * A write that carried a given-up state ended without its echo: the change counts as
   * discarded, also when the local state moved on meanwhile (e.g. a fresh state after a key
   * deletion), unless a rebase replayed its actions (that clears the flag).
   */
  function endDiscardedWrite(write: NonNullable<typeof inFlight>) {
    if (write.discardUnlessEchoed && !write.echoed) warnDiscarded();
  }

  /**
   * The key was deleted while an own change was coming: replay the actions the room did not
   * hold then (after rootSeq) on a fresh state, which is written. False when not possible.
   */
  function restartAfterDeletion(): boolean {
    const pending = log.filter((entry) => entry.seq > rootSeq);
    const fresh = initializeEmptyState();
    const replayed = replay(fresh, pending);
    if (!replayed) return false;
    if (replayed.lost) notify(REPLACED_WARNING, 'WARNING');
    debug('restart', pending.length, 'actions after a key deletion');
    const next = { ...replayed.state, revision: nextRevision(), writerId };
    rebaseOrigins.set(next, { replaced: identityOf(local()), from: pending[0]?.before ?? null, base: fresh });
    dispatchInternal(next);
    if (!busy()) void kick();
    return true;
  }

  /** A room value of our key from an event, or from a read handled like one (`read`). */
  function handleRoomChange(metadata: Metadata, read = false) {
    if (stopped) return;
    eventCount++;
    const previous = lastResult;
    // A foreign state that the local state does not follow yet: if our echo comes next, our
    // write landed after it.
    const overwritten = foreignPending() ? (previous as Extract<ParseResult, { kind: 'ok' }>) : null;
    record(metadata, !read);
    const mine = lastSeen?.writerId === writerId ? lastSeen : null;
    const unchanged = sameRoomValue(previous, lastResult);
    if (mine && echoWait && sameIdentity(mine, echoWait.id)) clearEchoWait();
    if (inFlight && !inFlight.echoed) {
      if (mine && sameIdentity(mine, inFlight.id)) inFlight.echoed = true;
      // A new foreign value, or an own attempt that may land late, before our echo: the order
      // is unknown (our echo may still come, or be coalesced away), see writeLoop.
      else if (mine ? mayLandLate(mine) : !unchanged) inFlight.otherBeforeEcho = true;
    }
    if (unchanged) {
      // Our key did not change. If other keys freed space, a too-large state may fit now.
      if (snapshot.status === 'too-large' && dirty() && canWrite()) void kick();
      return;
    }
    const now = local();
    if (mine && sameIdentity(mine, identityOf(now))) {
      acked = mine; // e.g. an attempt reported as failed landed after all
      savedSeq = Math.max(savedSeq, lineage.get(idKey(mine)) ?? 0);
      setSnapshot({ status: 'ready' });
      if (overwritten) rebase(overwritten.state, overwritten.parent, true);
    } else if (mine && now.writerId === writerId && now.revision > mine.revision && canWrite() && now !== discarded) {
      // An older write of ours. Usually its echo is just late and our newer state is written or
      // coming. But an attempt reported as failed may have landed after the newer state was
      // written (its write finished or its echo arrived): write the newer state again.
      if (mayLandLate(mine) && sameIdentity(acked, identityOf(now))) {
        dispatchInternal({ ...now, revision: nextRevision(), writerId });
        void kick();
      }
      return;
    } else {
      follow();
      // An own state that is not the local one: its echo may be late (after newer values):
      // read the room once to be sure.
      if (mine) void resync();
    }
  }

  /** True when two room values of our key are the same (same state identity, or same non-state kind). */
  function sameRoomValue(a: ParseResult | null, b: ParseResult | null): boolean {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === 'ok' && b.kind === 'ok') return sameIdentity(identityOf(a.state), identityOf(b.state));
    return true;
  }

  async function initialLoad() {
    for (let attempt = 0; !stopped; attempt++) {
      try {
        let metadata = await obr.room.getMetadata();
        if (eventCount > 0 || stopped) return; // an event already delivered newer data
        if (metadata[STATE_KEY] === undefined && isGm()) {
          // Confirm absence before a GM creates a new encounter.
          metadata = await obr.room.getMetadata();
          if (eventCount > 0 || stopped) return;
        }
        record(metadata);
        if (lastResult) apply(lastResult);
        return;
      } catch (error) {
        if (eventCount > 0 || stopped) return;
        debug('read failed', error);
        const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        if (attempt >= RETRY_DELAYS_MS.length - 1) setSnapshot({ status: 'error' });
        await delay(wait);
        if (eventCount > 0) return;
      }
    }
  }

  // ---------- outbound ----------

  function onStoreChange() {
    if (internalDispatch) return;
    const state = local();
    if (state === lastStoreState) return;
    lastStoreState = state;
    if (!canWrite()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(kick, debounceMs);
  }

  /** Cancel the debounce and queue a write loop. */
  function kick(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    scheduled++;
    queue = queue.then(writeLoop).catch((error) => debug('write loop error', error));
    return queue;
  }

  /** Returns false (and sets status) when the state must not be written. */
  function checkSize(state: EncounterState): boolean {
    const bytes = measureJsonBytes({ [STATE_KEY]: encodeEncounterState(state) });
    const budget = ROOM_LIMIT_BYTES - otherKeysBytes - SAFETY_BYTES;
    const nearLimit = bytes > WARN_BYTES;
    setSnapshot({ bytes, nearLimit });
    if (bytes > budget) {
      if (!tooLargeNotified) {
        notify('Initiative tracker: too much data to save in this room. Remove some combatants.', 'ERROR');
        tooLargeNotified = true;
      }
      setSnapshot({ status: 'too-large' });
      return false;
    }
    tooLargeNotified = false;
    if (nearLimit && !warned) {
      notify('Initiative tracker: room storage is almost full. Remove some combatants.', 'WARNING');
    }
    warned = nearLimit;
    return true;
  }

  /** Write the newest local state until the room holds it, or a terminal failure. */
  async function writeLoop() {
    try {
      for (let attempt = 1; dirty() && canWrite(); ) {
        if (foreignPending()) {
          // A foreign state arrived while this write was coming: include it first.
          const room = lastResult as Extract<ParseResult, { kind: 'ok' }>;
          rebase(room.state, room.parent);
          continue;
        }
        let state = local();
        if (state.revision <= maxSeenRevision) {
          // Made on a copy that is older than the room: stamp it above what we saw.
          dispatchInternal({ ...state, revision: nextRevision(), writerId });
          state = local();
        }
        if (!checkSize(state)) return;
        const id = identityOf(state);
        maxWrittenRevision = Math.max(maxWrittenRevision, id.revision);
        const seq = lastSeq;
        remember(id, seq);
        for (const entry of log) entry.sentRevision ??= id.revision;
        const write = (inFlight = { id, echoed: false, otherBeforeEcho: false, discardUnlessEchoed: false });
        try {
          await obr.room.setMetadata({ [STATE_KEY]: encodeEncounterState(state, acked ?? NO_PARENT, CLIENT_INFO) });
        } catch (error) {
          inFlight = null;
          debug('write failed', attempt, error);
          endDiscardedWrite(write);
          if ((error as { error?: { name?: unknown } } | null)?.error?.name !== 'RateLimitHit') {
            failedAttempts.add(idKey(id));
            if (!write.echoed) waitForEcho(id); // it may land later
          }
          if (isRetryableError(error) && attempt < MAX_WRITE_ATTEMPTS) {
            await delay(RETRY_DELAYS_MS[attempt - 1]);
            attempt++;
            continue;
          }
          notify('Initiative tracker: changes could not be saved. Your next change will retry.', 'ERROR');
          setSnapshot({ status: 'error' });
          return;
        }
        inFlight = null;
        savedSeq = Math.max(savedSeq, seq);
        debug('wrote', id);
        if (!write.echoed) waitForEcho(id);
        endDiscardedWrite(write);
        attempt = 1;
        // Clear a failure only: an event during the write may have set too-new / invalid.
        if (failed()) setSnapshot({ status: 'ready' });
        if (write.otherBeforeEcho && !write.echoed) {
          // Another value arrived during the write and our echo did not (it may come later, or
          // be coalesced away): we cannot tell which landed last.
          if (foreignPending()) {
            const room = lastResult as Extract<ParseResult, { kind: 'ok' }>;
            rebase(room.state, room.parent); // our actions on top of it are written next
            // It was adopted: our write may have landed after it.
            if (local().writerId !== writerId) void resync();
          } else if (local() === discarded) {
            // Invalid data or a newer version arrived: our state is not written again. The
            // room may hold either: read it once.
            void resync();
          } else if (sameIdentity(identityOf(local()), id)) {
            dispatchInternal({ ...local(), revision: nextRevision(), writerId }); // write it again
          }
          continue; // a newer local change is written next anyway
        }
        if (!sameIdentity(identityOf(local()), id)) {
          // A room value was adopted during the write (e.g. while demoted). Without our echo
          // the room may now hold our write: read it to find out.
          if (!write.echoed && local().writerId !== writerId) void resync();
          continue; // or a newer local change: write it
        }
        acked = id;
        // No value of our key arrived during the write: the room holds our state, also when it
        // held invalid data before (the GM reset it) and our echo is missing. With an echo,
        // handleRoomChange set the status in room order.
        if (!write.echoed) setSnapshot({ status: 'ready' });
      }
    } finally {
      scheduled--;
      // The loop stopped (e.g. a failed write) with a foreign state it did not follow yet.
      if (!stopped && scheduled === 0 && timer === null && canWrite() && foreignPending()) follow();
      if (!stopped && snapshot.loaded && !canWrite()) {
        onRoleChange();
        // Without an echo this client cannot tell whether its last write landed, and no later
        // write of its own will fix the order: read the room once.
        void resync();
      }
    }
  }

  /**
   * Called on every role change and when a write loop ends without the right to write. A
   * client that may not write (e.g. a demoted GM) follows the room again: an unsaved change
   * is discarded with a warning. A client promoted to GM in a room without state creates one.
   */
  function onRoleChange() {
    if (stopped || !snapshot.loaded || busy()) return;
    if (canWrite()) {
      if (lastResult?.kind === 'absent' && snapshot.status === 'absent-player') apply(lastResult);
      return;
    }
    if (dirty() || failed()) {
      follow();
      // The room may hold an earlier write of ours whose echo never came: read it once.
      void resync();
    }
  }

  /** Read the room once if the echo of this write attempt has not arrived after ECHO_WAIT_MS. */
  function waitForEcho(id: Identity) {
    clearEchoWait();
    const timer = setTimeout(() => {
      echoWait = null;
      void resync();
    }, ECHO_WAIT_MS);
    echoWait = { id, timer };
  }

  function clearEchoWait() {
    if (echoWait) clearTimeout(echoWait.timer);
    echoWait = null;
  }

  /** Room events may have been missed (e.g. the iframe was hidden or offline): read the room once. */
  function onWake() {
    if (stopped || !snapshot.loaded || wakeRead) return;
    wakeRead = resync(true).finally(() => {
      wakeRead = null;
    });
  }

  /**
   * Read the room once and handle it like a room event (unless an event arrived meanwhile).
   * `missedEvents`: events may have been lost, so a state of unknown lineage is handled too.
   */
  async function resync(missedEvents = false) {
    const before = eventCount;
    try {
      const metadata = await obr.room.getMetadata();
      // A read can be ahead of the events still on their way: when it holds a state whose
      // lineage is not known yet, those events (its ancestors first) bring it.
      const read = parseRoomValue(metadata[STATE_KEY]);
      if (!missedEvents && read.kind === 'ok' && includedSeq(read.state, read.parent) === null) return;
      if (!stopped && eventCount === before) handleRoomChange(metadata, true);
    } catch (error) {
      debug('resync read failed', error);
    }
  }

  // ---------- public ----------

  return {
    start() {
      if (!startPromise) {
        unsubscribers.push(store.subscribe(onStoreChange));
        if (store.subscribeActions) unsubscribers.push(store.subscribeActions(logAction));
        if (subscribeRole) unsubscribers.push(subscribeRole(onRoleChange));
        if (subscribeWake) unsubscribers.push(subscribeWake(onWake));
        unsubscribers.push(obr.room.onMetadataChange((metadata) => handleRoomChange(metadata)));
        startPromise = initialLoad();
      }
      return startPromise;
    },
    async flush() {
      while (timer || scheduled > 0) {
        if (timer) void kick();
        await queue;
      }
      return !dirty();
    },
    retry() {
      if (!canWrite() || !failed()) return queue;
      return kick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      clearEchoWait();
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getMaxSeenRevision: () => Math.max(maxSeenRevision, maxWrittenRevision),
    getRoomIdentity: () => lastSeen,
  };
}
