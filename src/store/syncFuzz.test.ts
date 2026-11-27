// Randomised multi-iframe test of the sync engine and the undo store.
//
// Each iframe (popover, modal, background page) has its own store, engine, writerId and
// undo store; the iframes of one tab share one sessionStorage (with `storage` events).
// Every seed has 1–2 GM browsers and a player. A simulated room delivers events to each
// iframe in room order but at random times (optionally coalesced: only the latest queued
// value), and settles writes in random steps, so an own echo can arrive before or after
// setMetadata resolves. Faults: write latency, RateLimitHit, timeouts that land later (or
// never), other rejections, echoes that never arrive, the room size limit, other
// extensions' keys, key deletion, a newer app version's state, a released v1 writer, role changes (heard by each
// iframe after its own delay), and lost events (a dropped connection; also the echo of a timed-out write
// that lands later): the iframe recovers when it becomes visible again (a wake read).
//
// Every run is deterministic per seed: Math.random, crypto (action seeds, row ids, undo ids), the clock
// and all timers are driven by the seed, so a failing seed reproduces exactly
// (SYNC_FUZZ_SEED=<n> runs only seed n, SYNC_FUZZ_LOG=<n> prints its log).
//
// First nobody presses the "Not saved – retry" chip: the system must become quiet anyway, and an
// iframe left in `error` still shows its own unsaved change and got the error notification.
// Once quiet (retry pressed), every iframe (players and demoted GMs included) must show the room's value
// (the same encoded state and status `ready`; an empty tracker when the key is absent;
// too-new when the room holds a newer version); the room's revision is at least every
// revision its writer received (unless its role changed); iframes that think they are
// players never write; nobody writes while showing too-new; no write happens before the
// first successful read.
//
// No GM action is lost: every participant a GM added is in the final room state or in one of
// its ancestors (the chain of stored `parent` identities; a later reset or undo may remove
// it), unless that GM got the "unsaved change was discarded" (or, nothing unsaved, "may have
// replaced your last change") warning after adding it, its own
// iframe removed it (reset / undo) before it reached the room, or an outside write (key
// deletion, invalid data, a newer version) replaced the state. No action is applied twice (no
// stored state has a duplicate row id). Without faults, role changes and outside writes, no
// warning is shown at all, except to an iframe whose Undo met a concurrent change, or whose
// keeper choice a concurrent change made void ("may have replaced", review 7).
//
// Turn navigation (Next / Previous / Start Round of a GM, recorded per action) follows one rule:
// it is replayed only onto a state on the turn position it was made on, else dropped silently
// (never a warning). Checked on every replay the engine reports: on that position, never after the
// action was dropped, and never twice (not onto a state whose lineage already holds an own write
// that applied it, for iframes that got every event). `strict` configs (no faults, every event
// delivered, only actions that never move the turn back or remove a row) must show no warning at
// all; `conflicts` configs (the same delivery, every action) allow only the content warnings of the
// no-fault rule (an Undo, a voided keeper choice).
//
// No write storm: the system must become quiet within a bounded number of rounds, then
// stay quiet (no setMetadata call in a long window with faults off), and the total number
// of writes is bounded by the number of local actions, failed attempts and outside events.
//
// SYNC_FUZZ_SEEDS=2000 yarn vitest run src/store/syncFuzz.test.ts  runs more seeds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@owlbear-rodeo/sdk', () => import('../test/obrMock').then((m) => m.createSdkModule()));

import type { Metadata } from '@owlbear-rodeo/sdk';
import { createAppStore, type AppStore } from './store';
import { APP_VERSION, createSyncEngine, ROOM_LIMIT_BYTES, STATE_KEY, SYNC_PROTOCOL, type SyncEngine, type SyncObr, type SyncTrace } from './syncEngine';
import { encodeEncounterState, measureJsonBytes, parseEncounterState } from './stateCodec';
import {
  createParticipant, reset, setPrivacy, removeParticipant, dealRound, startRound, endRound, setActiveParticipant,
  setHold, insertActNow, addCandidateCard, selectKeeperCard, undoLastDraw, discardExtraCandidates, loseHold,
  setInactive, endInitiative, removeAllNpcsAndExtras, findTurnIndexFrom, swadeSlice,
} from './swadeSlice';
import { generateAllCardIds } from '../utils/cardIds';
import { hashString } from '../utils/shuffle';

const ALL_CARDS = generateAllCardIds();
/** Deck invariant on a state (in memory, or a raw stored value before the codec repairs it). */
function deckProblems(s: { deck: { remaining: string[]; inPlay: string[]; discard: string[] }; rows: { id: string; currentCardId?: string; candidateIds: string[] }[]; turn: { activeRowId: string | null } }): string[] {
  const out: string[] = [];
  const all = [...s.deck.remaining, ...s.deck.inPlay, ...s.deck.discard];
  if (all.length !== 54 || new Set(all).size !== 54 || !ALL_CARDS.every((c) => all.includes(c as never))) out.push(`deck has ${all.length} cards, ${new Set(all).size} unique`);
  const inPlay = new Set(s.deck.inPlay);
  const held = new Map<string, string>();
  for (const row of s.rows) {
    const cards = new Set([...(row.candidateIds ?? []), ...(row.currentCardId ? [row.currentCardId] : [])]);
    for (const c of cards) {
      if (!inPlay.has(c)) out.push(`row ${row.id} holds ${c} not in play`);
      if (held.has(c)) out.push(`card ${c} on rows ${held.get(c)} and ${row.id}`);
      held.set(c, row.id);
    }
    if (row.currentCardId && !(row.candidateIds ?? []).includes(row.currentCardId)) out.push(`row ${row.id} keeper not among candidates`);
  }
  for (const c of inPlay) if (!held.has(c)) out.push(`in-play card ${c} on no row`);
  const ids = s.rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) out.push('duplicate row id');
  if (s.turn.activeRowId !== null && !ids.includes(s.turn.activeRowId)) out.push(`active row ${s.turn.activeRowId} missing`);
  return out;
}
import { LocalUndoStore } from './localUndoStore';
import { initializeEmptyState } from './initialState';
import type { EncounterState } from './types';

/** Node's environment (the app's tsconfig has no Node types). */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SEEDS = Number(env.SYNC_FUZZ_SEEDS ?? 40);
/** Run only this seed number (to reproduce a failure). */
const ONLY_SEED = env.SYNC_FUZZ_SEED ? Number(env.SYNC_FUZZ_SEED) : null;
const STEPS = Number(env.SYNC_FUZZ_STEPS ?? 150);
/** Rounds (10 s of simulated time each) the system may take to become quiet after the last action. */
const MAX_QUIESCE_ROUNDS = 20;
/** Most rounds any seed needed, and the highest writes / budget ratio (SYNC_FUZZ_STATS=1 logs them). */
let maxRounds = 0;
let maxBudgetUse = 0;
/** Older-version notices shown in the current config (all seeds). */
let olderNotices = 0;
/** Turn navigation replayed or dropped in the current config (all seeds; SYNC_FUZZ_STATS=1 logs them). */
const traceCounts = { replayed: 0, dropped: 0 };

/** Small deterministic PRNG (mulberry32). */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clone = <T,>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
const idOf = (r: ReturnType<typeof parseEncounterState>) => (r.kind === 'ok' ? `${r.state.revision}/${r.state.writerId}` : r.kind);
/** Rows and settings in stored form, so local and room states compare. */
const content = (s: EncounterState) => {
  const parsed = parseEncounterState(encodeEncounterState(s));
  return parsed.kind === 'ok' ? JSON.stringify([parsed.state.rows, parsed.state.settings]) : '';
};
/** A stored value without the sync-only `parent` and `client`, to compare with an encoded local state. */
const withoutParent = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const { parent: _parent, client: _client, ...rest } = raw as Record<string, unknown>;
  return rest;
};
const names = (s: EncounterState) => new Set(s.rows.map((r) => r.name));

type WriteMode = 'ok' | 'rateLimit' | 'timeoutLands' | 'timeoutLost' | 'reject';
const TIMEOUT = () => new Error('Message OBR_ROOM_SET_METADATA took longer than 5000ms to get a result');
/** Data that cannot be parsed. */
const INVALID = { round: 1, phase: 'in_round', deck: {}, rows: {} };
/** A state written by a newer app version. */
const TOO_NEW = { ...(encodeEncounterState({ ...initializeEmptyState(), revision: 99, writerId: 'v3' }) as object), version: 99 };

interface Options {
  /** Number of GM browsers (default 1-2). */
  gms?: number;
  /** Rich actions: deal, turns, hold, act now, card chooser, removals. */
  rich?: boolean;
  /** Frames are cut off from events for long stretches (slow connection). */
  partition?: boolean;
  /**
   * A released v1 GM writes at times: it copies the room value with its unknown keys (our
   * `parent` included), sets version 1, raises the revision by one and changes something.
   */
  v1?: boolean;
  /** The v1 GM copies a stale room value (one of the last states that landed) instead of the current one. */
  v1Stale?: boolean;
  /**
   * A GM of this app version whose write the host applies late (its tab may be gone): a change
   * (rename, Hold, Next) made on one of the last states that landed, stored with that state as
   * its parent (known lineage), so the room can go back to an older branch (review 9).
   */
  late?: boolean;
  /** GMs press Next / Previous much more often (rich actions). */
  turns?: boolean;
  /**
   * Rich actions that never move the turn back or remove a row (no Previous, interrupting Act Now,
   * removal, End Initiative, reset, keeper choice); with `strict`, no warning may appear at all.
   */
  forward?: boolean;
  /** No warning at all is allowed (with `forward` and no faults, review 10). */
  strict?: boolean;
  /**
   * With `strict` delivery but every action (Previous, Act Now, Hold, Lose Turn, late joiners,
   * removals, keeper choices): only the content warnings of the no-fault rule are allowed.
   */
  conflicts?: boolean;
  /** Seeds of this config in a default run, as a share of SYNC_FUZZ_SEEDS (CI time). */
  seedShare?: number;
  faults: boolean;
  noEcho: boolean;
  roles: boolean;
  keys: boolean;
  undo: boolean;
  /** Deliver only the latest queued room value at times (a host may coalesce events). */
  coalesce?: boolean;
  /** Each iframe learns of a role change after its own delay (player.onChange per iframe). */
  roleLag?: boolean;
  /** Unreadable data appears in the room at times (a GM then resets it). */
  invalid?: boolean;
  /** Another client of a newer app version writes a too-new state at times. */
  tooNew?: boolean;
  /**
   * Room events to an iframe are lost at times (also the echo of a timed-out write that lands
   * later); an iframe that becomes visible again reads the room (wake).
   */
  drops?: boolean;
  /**
   * A GM iframe loses every room event for a stretch (until it becomes visible again), and is
   * often woken right after its own Next: its unsaved turn action meets a state of unknown lineage.
   */
  deaf?: boolean;
  /**
   * GMs only add participants (no reset, no privacy toggle), so nobody removes a row. A warning
   * is allowed only when the iframe then shows a state without a row it added (N1: a state of
   * unknown lineage that holds all our actions is followed silently).
   */
  addOnly?: boolean;
}

/** Where the turn is (as the engine compares it): round, phase and active row. */
const turnOf = (s: EncounterState) => `${s.round}|${s.phase}|${s.turn.activeRowId ?? ''}`;

interface Nav {
  frame: Frame;
  what: string;
  step: number;
  /** Tick (see `tick`) when it was made: an own write made later carries it. */
  madeAt: number;
  before: string;
  after: string;
  /** The room state it was dropped on (it left the log). */
  dropped: string | null;
}

interface Write {
  frame: Frame;
  patch: Partial<Metadata>;
  mode: WriteMode;
  echo: boolean;
  landed: boolean;
  rejected: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface Frame {
  name: string;
  /** The role as this iframe last heard it. */
  role: "GM" | "PLAYER";
  roleSeq: number;
  roleListeners: Set<() => void>;
  wakeListeners: Set<() => void>;
  /** Highest state revision delivered to this iframe. */
  maxDelivered: number;
  /** The last value delivered was too-new and the engine shows too-new. */
  showsTooNew: boolean;
  browser: Browser;
  queue: { metadata: Metadata; own: boolean }[];
  listeners: Set<(metadata: Metadata) => void>;
  notes: string[];
  /** Steps at which this iframe showed the "unsaved change was discarded" warning. */
  warnedAt: number[];
  /** Steps at which it showed the "may have replaced your last change" warning (nothing unsaved). */
  replacedAt: number[];
  /** Steps at which this iframe's Undo succeeded. */
  undoneAt: number[];
  /** Loses every room event until it wakes (`deaf`). */
  deaf: boolean;
  /** Last step at which a room event to this iframe was lost or coalesced away (-1: never). */
  lastLoss: number;

  /** Wakes at the start of the next step, its read answered at once (before its debounce ends). */
  wakeSoon: boolean;
  /** Room values handed to this iframe (events, read results) since its last warning check. */
  received: Metadata[];
  /**
   * An event of a state with a stored `client` was delivered (`aware`), and after it a GM got an
   * event of a state without it (an older app wrote: `olderSeen`, told once).
   */
  clients: { aware: boolean; olderSeen: boolean };
  /** Steps at which this iframe chose a keeper card (a concurrent change can make that choice void). */
  keptAt: number[];
  /** Participants this iframe's own reset / undo removed from its local state. */
  removedLocally: Set<string>;
  /** Steps at which this iframe reset the tracker (its own turn navigation before is gone). */
  resetAt: number[];
  /** Every own local action that moved the turn: step and turn positions. */
  turnMoves: { step: number; before: string; after: string }[];
  store: AppStore;
  engine: SyncEngine;
  undo: LocalUndoStore;
  events: EventTarget;
}

interface Browser {
  role: 'GM' | 'PLAYER';
  roleChanged: boolean;
  storage: Map<string, string>;
  frames: Frame[];
}

class Room {
  metadata: Metadata = {};
  writes: Write[] = [];
  reads: { resolve: (m: Metadata) => void; reject: (e: unknown) => void; fail: boolean; frame: Frame }[] = [];
  browsers: Browser[] = [];
  frames: Frame[] = [];
  /** Identity of every state that landed, with its revision. */
  landed: { id: string; revision: number }[] = [];
  /**
   * Every state that landed: its participants, its parent identity (stored; for a v1 write the
   * state it copied), its turn position, its writer, the index it landed at, and whether it
   * moved the turn relative to its parent (unknown parent: counts as moved).
   */
  lineage = new Map<string, { names: Set<string>; parent: string | null; turn: string; writer: string; at: number; moved: boolean; rows: Set<string>; hash: number; state: EncounterState }>();
  /**
   * Identities that landed with different contents (v1 GMs all write writerId "": two of their
   * states can share an identity). A lineage through one of them is not known.
   */
  ambiguous = new Set<string>();
  /** GM turn navigation, per action object (the engine logs the dispatched object). */
  navs = new Map<unknown, Nav>();
  /** Order of navigations and writes as they were made (a write holds the local state at that moment). */
  tick = 0;
  /** Tick when each state was first written (made), per identity. */
  madeAt = new Map<string, number>();
  /** Raw stored states that landed, newest last (a stale v1 writer copies one). */
  history: Record<string, unknown>[] = [];
  /** A v1 write in progress: its parent (the copied state) and writer. */
  v1Copy: string | null = null;
  /** Step of the last outside write other than a v1 GM's (deletion, invalid data, a newer version). */
  lastResetWrite = -1;
  /** Participants added by GMs: name, iframe, step. */
  created: { name: string; frame: Frame; step: number }[] = [];
  /** Step of the last outside write of our key (deletion, invalid data, a newer version). */
  lastOutsideWrite = -1;
  stepNo = 0;
  cut = new Set<Frame>();
  nameCounter = 0;
  violations: string[] = [];
  log: string[] = [];
  /** Counters for the write-storm bound. */
  stats = { writes: 0, actions: 0, failures: 0, outside: 0 };
  /** Faults stopped (the quiet window): every write and read succeeds and echoes. */
  faultsOff = false;

  /** Writes allowed: 3 per local action, 1 per failed attempt, 2 per iframe per outside event (key change, role change), 2 per iframe. */
  writeBudget(): number {
    const { actions, failures, outside } = this.stats;
    return 3 * actions + failures + 2 * this.frames.length * (outside + 1);
  }

  constructor(
    readonly rnd: () => number,
    readonly options: Options
  ) {}

  pick<T>(list: T[]): T {
    return list[Math.floor(this.rnd() * list.length)];
  }

  /** Apply a patch (shallow merge); false when over the room limit. */
  apply(patch: Partial<Metadata>, writer: Frame | null, echo = true): boolean {
    const next = { ...this.metadata };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = clone(value);
    }
    if (measureJsonBytes(next) > ROOM_LIMIT_BYTES) return false;
    this.metadata = next;
    const parsed = parseEncounterState(next[STATE_KEY]);
    if (STATE_KEY in patch && !writer) this.lastOutsideWrite = this.stepNo;
    if (STATE_KEY in patch && !writer && this.v1Copy === null) this.lastResetWrite = this.stepNo;
    if (STATE_KEY in patch && writer && typeof next[STATE_KEY] === 'object') {
      try {
        const raw = next[STATE_KEY] as never;
        for (const problem of deckProblems(raw)) this.violations.push(`stored ${idOf(parsed)} by ${writer.name}: ${problem}`);
      } catch (e) { this.violations.push(`stored state unreadable ${String(e)}`); }
    }
    if (parsed.kind === 'ok') {
      this.landed.push({ id: idOf(parsed), revision: parsed.state.revision });
      const parent = this.v1Copy ?? (parsed.parent ? `${parsed.parent.revision}/${parsed.parent.writerId}` : null);
      const turn = turnOf(parsed.state);
      const parentTurn = parent ? this.lineage.get(parent)?.turn : undefined;
      const hash = hashString(JSON.stringify(withoutParent(next[STATE_KEY])));
      const known = this.lineage.get(idOf(parsed));
      if (known && known.hash !== hash) this.ambiguous.add(idOf(parsed));
      if (!known) {
        this.lineage.set(idOf(parsed), {
          names: names(parsed.state), parent, turn, writer: parsed.state.writerId, at: this.landed.length,
          moved: parentTurn === undefined || parentTurn !== turn, rows: new Set(parsed.state.rows.map((r) => r.id)), hash, state: parsed.state,
        });
      }
      this.history.push(clone(next[STATE_KEY]) as Record<string, unknown>);
      if (this.history.length > 8) this.history.shift();
      const ids = ((next[STATE_KEY] as { rows?: { id?: unknown }[] }).rows ?? []).map((r) => r.id);
      if (new Set(ids).size !== ids.length) this.violations.push(`${idOf(parsed)} holds a duplicate row (an action applied twice)`);
    }
    // The hash covers the whole stored value (row ids, deck order), so a rerun of a seed can be compared exactly.
    this.log.push(`land ${writer?.name ?? 'ext'} ${idOf(parsed)}${parsed.kind === 'ok' ? ` <- ${parsed.parent ? `${parsed.parent.revision}/${parsed.parent.writerId}` : '-'} [${[...names(parsed.state)].join(',')}]` : ''} #${hashString(JSON.stringify(next[STATE_KEY]) ?? '')}`);
    for (const frame of this.frames) {
      if (frame === writer && !echo) continue;
      frame.queue.push({ metadata: clone(next), own: frame === writer });
    }
    return true;
  }

  addBrowser(role: Browser['role'], frames: number) {
    const browser: Browser = { role, roleChanged: false, storage: new Map(), frames: [] };
    this.browsers.push(browser);
    for (let i = 0; i < frames; i++) this.addFrame(browser);
  }

  addFrame(browser: Browser) {
    const name = `w${this.frames.length}`;
    const frame = {
      name,
      role: browser.role,
      roleSeq: 0,
      roleListeners: new Set(),
      wakeListeners: new Set(),
      maxDelivered: 0,
      showsTooNew: false,
      browser,
      queue: [],
      listeners: new Set(),
      notes: [],
      received: [],
      clients: { aware: false, olderSeen: false },
      warnedAt: [],
      replacedAt: [],
      undoneAt: [],
      deaf: false,
      lastLoss: -1,

      wakeSoon: false,
      keptAt: [],
      removedLocally: new Set(),
      resetAt: [],
      turnMoves: [],
    } as unknown as Frame;
    const obr: SyncObr = {
      room: {
        getMetadata: () =>
          new Promise((resolve, reject) =>
            this.reads.push({ resolve, reject, fail: this.options.faults && !this.faultsOff && this.rnd() < 0.15, frame })
          ),
        setMetadata: (patch) =>
          new Promise((resolve, reject) => {
            if (frame.role !== 'GM') this.violations.push(`${name} wrote as a player`);
            if (frame.showsTooNew) this.violations.push(`${name} wrote after it showed too-new`);
            if (!frame.engine.getSnapshot().loaded) this.violations.push(`${name} wrote before loading`);
            this.stats.writes++;
            const written = idOf(parseEncounterState(patch[STATE_KEY]));
            if (!this.madeAt.has(written)) this.madeAt.set(written, this.tick++);
            this.log.push(`write ${name} ${written}${frame.showsTooNew ? ' (shows too-new)' : ''}`);
            const mode = this.writeMode();
            // A write that times out and lands later echoes, unless events can be lost: its writer
            // then learns only from a read (wake, or the read after a missing echo).
            const noEcho = this.options.noEcho && !this.faultsOff && this.rnd() < 0.3 && (mode !== 'timeoutLands' || !!this.options.drops);
            this.writes.push({
              frame,
              patch: clone(patch),
              mode,
              echo: !noEcho,
              landed: false,
              rejected: false,
              resolve,
              reject,
            });
          }),
        onMetadataChange: (callback) => {
          frame.listeners.add(callback);
          return () => frame.listeners.delete(callback);
        },
      },
      notification: {
        show: async (message) => {
          frame.notes.push(message);
          this.log.push(`note ${name} ${message}`);
          if (message.includes('unsaved change was discarded')) frame.warnedAt.push(this.stepNo);
          if (message.includes('may have replaced your last change')) frame.replacedAt.push(this.stepNo);
          if (this.options.addOnly) this.checkWarningJustified(frame, this.stepNo);
              return 'id';
        },
      },
    };
    const store = createAppStore({ writerId: name, getMinRevision: () => engine.getMaxSeenRevision() });
    const engine = createSyncEngine({
      store,
      obr,
      writerId: name,
      isGm: () => frame.role === 'GM',
      subscribeRole: (listener) => {
        frame.roleListeners.add(listener);
        return () => frame.roleListeners.delete(listener);
      },
      subscribeWake: (listener) => {
        frame.wakeListeners.add(listener);
        return () => frame.wakeListeners.delete(listener);
      },
      onTrace: (event) => this.trace(frame, event),
    });
    const events = new EventTarget();
    const notify = (key: string) => {
      for (const other of browser.frames) if (other !== frame) other.events.dispatchEvent(Object.assign(new Event('storage'), { key }));
    };
    const storage = {
      getItem: (key: string) => browser.storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        browser.storage.set(key, value);
        notify(key);
      },
      removeItem: (key: string) => {
        browser.storage.delete(key);
        notify(key);
      },
      key: (i: number) => [...browser.storage.keys()][i] ?? null,
      get length() {
        return browser.storage.size;
      },
      clear: () => browser.storage.clear(),
    } as Storage;
    const undo = new LocalUndoStore({
      store,
      writerId: name,
      roomId: 'room',
      getRoomIdentity: () => engine.getRoomIdentity(),
      storage,
      eventTarget: events as unknown as Window,
      channel: null, // the `storage` events above notify the sibling iframes
      legacyStorage: null,
    });
    Object.assign(frame, { store, engine, undo, events });
    engine.subscribe(() => {
      const { status } = engine.getSnapshot();
      this.log.push(`status ${name} ${status}`);
      // A read (resync) can move the engine past a too-new value that is still queued.
      if (status !== 'too-new') frame.showsTooNew = false;
    });
    browser.frames.push(frame);
    this.frames.push(frame);
    undo.start();
    void engine.start();
  }

  /** Run a GM's local action; participants its own reset / undo removes count as removed locally. */
  act(frame: Frame, run: () => unknown) {
    const beforeState = frame.store.getState().swade;
    const before = names(beforeState);
    const result = run();
    const afterState = frame.store.getState().swade;
    const after = names(afterState);
    for (const name of before) if (!after.has(name)) frame.removedLocally.add(name);
    if (turnOf(beforeState) !== turnOf(afterState)) frame.turnMoves.push({ step: this.stepNo, before: turnOf(beforeState), after: turnOf(afterState) });
    return result;
  }

  /** Dispatch a GM's turn navigation and record it (only when it changed the local state). */
  navigate(frame: Frame, action: { type: string }, what: string) {
    const before = frame.store.getState().swade;
    this.act(frame, () => frame.store.dispatch(action as never));
    const after = frame.store.getState().swade;
    if (after === before) return;
    if (this.options.deaf && frame.deaf) frame.wakeSoon = true; // see step
    this.navs.set(action, { frame, what, step: this.stepNo, madeAt: this.tick++, before: turnOf(before), after: turnOf(after), dropped: null });
  }

  /** The engine dropped or replayed an own action; checks the navigation rule on the state it compared. */
  trace(frame: Frame, event: SyncTrace) {
    const nav = this.navs.get(event.action);
    if (!nav) return;
    const on = `${event.on.revision}/${event.on.writerId}`;
    this.log.push(`trace ${frame.name} ${event.kind} ${nav.what}@${nav.step} (${nav.before} -> ${nav.after}) on ${on} at ${turnOf(event.state)}`);
    const where = `${frame.name}'s ${nav.what} (step ${nav.step}, ${nav.before} -> ${nav.after})`;
    traceCounts[event.kind]++;
    // Dropped once, it left the log: it is never checked (or replayed) again.
    if (nav.dropped) this.violations.push(`${where} was ${event.kind} on ${on} after it was dropped on ${nav.dropped} (step ${this.stepNo})`);
    if (event.kind === 'dropped') {
      nav.dropped = on;
      return;
    }
    if (turnOf(event.state) !== nav.before) this.violations.push(`${where} was replayed on ${on} at another turn position (${turnOf(event.state)}) (step ${this.stepNo})`);
    this.checkOnce(frame, nav, on, where);
  }

  /**
   * No turn navigation is applied twice: a replay onto `on` whose lineage holds an own write,
   * made after the action (so it carried it, whenever it landed), that moved the turn from the
   * action's position to its result (that write applied it). Checked when the iframe got every room event since the action (none
   * lost or coalesced away) and its role never changed.
   */
  checkOnce(frame: Frame, nav: Nav, on: string, where: string) {
    if (frame.lastLoss >= nav.step || frame.browser.roleChanged) return;
    const chain = this.chain(on);
    if (chain.some((id) => this.ambiguous.has(id))) return;
    // Start Round picks the first row of the deal it is applied on: compare round and phase only.
    const result = (turn: string) => (nav.what === 'start' ? turn.replace(/[^|]*$/, '') === nav.after.replace(/[^|]*$/, '') : turn === nav.after);
    for (const id of chain) {
      const entry = this.lineage.get(id);
      const madeAt = this.madeAt.get(id);
      if (!entry || madeAt === undefined || madeAt < nav.madeAt || entry.writer !== frame.name || !entry.parent) continue;
      if (this.lineage.get(entry.parent)?.turn !== nav.before || !result(entry.turn)) continue;
      this.violations.push(`${where} was replayed on ${on}, but its own write ${id} in that lineage already applied it: applied twice (step ${this.stepNo})`);
      return;
    }
  }

  /** Identities in the lineage of `id` (itself and its ancestors), oldest last. */
  chain(id: string | null): string[] {
    const out: string[] = [];
    for (; id && !out.includes(id); id = this.lineage.get(id)?.parent ?? null) out.push(id);
    return out;
  }

  /** A random game action as the UI would dispatch it (targets taken from the local state). */
  rich(frame: Frame) {
    const s = frame.store.getState().swade;
    const row = s.rows.length ? this.pick(s.rows) : undefined;
    const activeIndex = s.rows.findIndex((r) => r.id === s.turn.activeRowId);
    const d = (a: unknown) => this.act(frame, () => frame.store.dispatch(a as never));
    // `turns`: most actions are Next / Previous in a round, else a deal or Start Round.
    const turn = () => (s.phase === 'in_round' ? 0.24 + this.rnd() * 0.16 : s.phase === 'cards_dealt' ? 0.12 : 0.05);
    let x = this.options.turns && this.rnd() < 0.7 ? turn() : this.rnd();
    // `forward`: Previous becomes Next; removals, End Initiative and keeper choices become other actions.
    const forward = this.options.forward;
    if (forward && x >= 0.36 && x < 0.4) x = 0.3;
    if (forward && ((x >= 0.4 && x < 0.5) || x >= 0.95)) x = 0.53;
    if (forward && x >= 0.7 && x < 0.77) x = 0.77 + (x - 0.7) * (0.09 / 0.07); // undoDraw / cancelChooser
    // In a round: no Act Now, Hold, Lose Turn or Inactive (they change who is still to act).
    if (forward && s.phase === 'in_round' && ((x >= 0.5 && x < 0.62) || (x >= 0.86 && x < 0.95))) x = 0.65; // a draw
    let what: string;
    // `forward`: the deal's seed follows the round, so concurrent deals of one state deal alike.
    if (x < 0.1) { what = 'deal'; d(dealRound(forward ? 1000 + s.round : undefined)); }
    else if (x < 0.17) { what = 'start'; this.navigate(frame, startRound(), what); }
    else if (x < 0.24) { what = 'end'; d(endRound(forward ? 2000 + s.round : undefined)); }
    else if (x < 0.36) {
      what = 'next';
      const i = findTurnIndexFrom(s.rows, activeIndex + 1);
      // Nobody active in a round: the UI offers no Next (it would go back to the top).
      if (activeIndex >= 0 || s.phase !== 'in_round') this.navigate(frame, setActiveParticipant(i >= 0 ? s.rows[i].id : null), what);
    } else if (x < 0.4) {
      what = 'prev';
      let i = activeIndex - 1;
      while (i >= 0 && !(s.rows[i].currentCardId || s.rows[i].actNowTurn)) i--;
      if (i >= 0) this.navigate(frame, setActiveParticipant(s.rows[i].id), what);
    } else if (!row) { what = 'none'; }
    else if (x < 0.5) { what = 'remove'; d(removeParticipant(row.id)); }
    else if (x < 0.56) { what = 'hold'; d(setHold({ id: row.id, value: !row.onHold })); }
    else if (x < 0.62) {
      what = 'actnow';
      // With nobody active the row goes last and takes the turn: the turn moves back from the end.
      if (!forward || activeIndex >= 0) d(insertActNow({ id: row.id, placement: !forward && this.rnd() < 0.5 ? 'before' : 'after' }));
    }
    else if (x < 0.7) { what = 'draw'; d(addCandidateCard(row.id)); }
    else if (x < 0.77) {
      what = 'keep';
      if (row.candidateIds.length) {
        d(selectKeeperCard({ participantId: row.id, cardId: this.pick(row.candidateIds) }));
        frame.keptAt.push(this.stepNo);
      }
    } else if (x < 0.82) { what = 'undoDraw'; d(undoLastDraw(row.id)); }
    else if (x < 0.86) { what = 'cancelChooser'; d(discardExtraCandidates(row.id)); }
    else if (x < 0.9) { what = 'loseHold'; if (!forward || s.phase !== 'cards_dealt') d(loseHold(row.id)); }
    else if (x < 0.95) { what = 'inactive'; d(setInactive({ id: row.id, value: !row.inactive })); }
    else if (x < 0.98) { what = 'endInit'; d(endInitiative()); }
    else { what = 'removeAllNpcs'; d(removeAllNpcsAndExtras()); }
    this.log.push(`rich ${frame.name} ${what}`);
  }

  /**
   * `forward`: an iframe other than the first one only presses Next (in a round) or toggles
   * privacy: nothing that changes the order or which rows still have a turn. A concurrent add,
   * hold or draw would deal another order, and a concurrent Act Now, late joiner or Hold changes
   * which rows are still to act; navigation made on the old order is then rightly given up with
   * the warning.
   */
  follower(frame: Frame) {
    const s = frame.store.getState().swade;
    const active = s.rows.findIndex((r) => r.id === s.turn.activeRowId);
    const x = this.rnd();
    if (s.phase === 'in_round' && active >= 0 && x < 0.7) {
      const i = findTurnIndexFrom(s.rows, active + 1);
      this.navigate(frame, setActiveParticipant(i >= 0 ? s.rows[i].id : null), 'next');
      this.log.push(`follower ${frame.name} next`);
    } else {
      this.act(frame, () => frame.store.dispatch(setPrivacy(!s.settings.hideNpcFromPlayers)));
      this.log.push(`follower ${frame.name} privacy`);
    }
  }

  /** A released v1 GM's change: spread of the room value, version 1, revision + 1. */
  v1Write() {
    const current = this.metadata[STATE_KEY];
    if (typeof current !== 'object' || current === null) return;
    // A stale copy: an older app that missed the latest states writes over them.
    const stale = this.options.v1Stale && this.history.length ? this.pick(this.history) : null;
    const raw = stale ?? current;
    const copied = parseEncounterState(raw);
    if (copied.kind !== 'ok') return;
    // v1 states all have writerId "": a stale copy gets a revision above every state so far, so
    // no two of them share an identity (the lineage stays known to the checks).
    const revision = stale ? Math.max(0, ...this.landed.map((l) => l.revision)) + 1 : Number((current as { revision?: unknown }).revision ?? 0) + 1;
    const v1: Record<string, unknown> = { ...clone(raw), version: 1, revision };
    const rows = v1.rows as Record<string, unknown>[];
    const y = this.rnd();
    if (rows.length && y < 0.5) {
      const row = this.pick(rows);
      row.onHold = !row.onHold;
    } else if (y < 0.8) {
      const name = `v1-${this.nameCounter++}`;
      rows.push({ id: name, name, type: 'NPC', inactive: false, onHold: false, revealed: false, candidateIds: [] });
    } else {
      const settings = v1.settings as { hideNpcFromPlayers: boolean };
      settings.hideNpcFromPlayers = !settings.hideNpcFromPlayers;
    }
    this.v1Copy = idOf(copied);
    try {
      this.apply({ [STATE_KEY]: v1 }, null);
    } finally {
      this.v1Copy = null;
    }
  }

  /**
   * A GM of this app version whose write the host applies late: a change made on one of the last
   * states that landed (often an older one), stored with that state as its parent.
   */
  lateWrite() {
    if (!this.history.length) return;
    const copied = parseEncounterState(this.pick(this.history));
    if (copied.kind !== 'ok') return;
    let state: EncounterState = copied.state;
    const y = this.rnd();
    const active = state.rows.findIndex((r) => r.id === state.turn.activeRowId);
    if (state.phase === 'in_round' && y < 0.5) {
      const i = findTurnIndexFrom(state.rows, active + 1);
      state = swadeSlice.reducer(state, setActiveParticipant(i >= 0 ? state.rows[i].id : null));
    } else if (state.rows.length && y < 0.75) {
      const row = this.pick(state.rows);
      state = { ...state, rows: state.rows.map((r) => (r === row ? { ...r, onHold: !r.onHold } : r)) };
    } else {
      const name = `late-${this.nameCounter++}`;
      state = { ...state, rows: [...state.rows, { id: name, name, type: 'NPC', inactive: false, onHold: false, revealed: false, candidateIds: [] }] };
    }
    const writer = `late${this.nameCounter++}`;
    const parent = { revision: copied.state.revision, writerId: copied.state.writerId };
    this.log.push(`late ${writer} on ${idOf(copied)}`);
    // Not a reset: a GM's change with a known parent (v1Copy marks it so).
    this.v1Copy = idOf(copied);
    try {
      this.apply({ [STATE_KEY]: encodeEncounterState({ ...state, revision: copied.state.revision + 1, writerId: writer }, parent, { syncProtocol: SYNC_PROTOCOL, appVersion: APP_VERSION }) }, null);
    } finally {
      this.v1Copy = null;
    }
  }

  /**
   * `deaf`: another GM of this app version (its tab only writes) presses Next twice, in two
   * writes on the current room value: an iframe that misses both sees the second with a parent
   * it never saw (unknown lineage) and the turn moved.
   */
  ghostWrites() {
    let copied = parseEncounterState(this.metadata[STATE_KEY]);
    const writer = `ghost${this.nameCounter++}`;
    for (let i = 0; i < 2 && copied.kind === 'ok'; i++) {
      const base = copied.state;
      let state = base;
      if (base.phase === 'in_round') {
        const active = base.rows.findIndex((r) => r.id === base.turn.activeRowId);
        const next = findTurnIndexFrom(base.rows, active + 1);
        state = swadeSlice.reducer(base, setActiveParticipant(next >= 0 ? base.rows[next].id : null));
      } else if (base.rows.length) {
        state = { ...base, rows: base.rows.map((r, j) => (j === 0 ? { ...r, onHold: !r.onHold } : r)) };
      }
      this.log.push(`ghost ${writer} on ${idOf(copied)}`);
      this.v1Copy = idOf(copied); // a GM's change with a known parent, not a reset
      try {
        this.apply({ [STATE_KEY]: encodeEncounterState({ ...state, revision: base.revision + 1, writerId: writer }, { revision: base.revision, writerId: base.writerId }, { syncProtocol: SYNC_PROTOCOL, appVersion: APP_VERSION }) }, null);
      } finally {
        this.v1Copy = null;
      }
      copied = parseEncounterState(this.metadata[STATE_KEY]);
    }
  }

  /**
   * `deaf`: a GM iframe stops hearing room events; its content change is written; another GM
   * then presses Next twice (ghostWrites); the iframe presses Next (unsaved) and wakes at the
   * next step (its read answered before its debounce ends): its saved Next (if any) and its
   * unsaved one meet a state of unknown lineage where the turn moved.
   */
  async deafEpisode() {
    const ready = this.frames.filter((f) => f.role === 'GM' && f.engine.getSnapshot().status === 'ready');
    if (!ready.length) return;
    const frame = this.pick(ready);
    frame.deaf = true;
    this.log.push(`deaf ${frame.name}`);
    this.add(frame, 'd');
    this.stats.actions++;
    await vi.advanceTimersByTimeAsync(100);
    for (const write of this.writes.filter((w) => w.frame === frame)) this.progress(write, true);
    await this.flushMicrotasks();
    this.stats.outside++;
    this.ghostWrites();
    const s = frame.store.getState().swade;
    // Nobody active in a round: the UI offers no Next.
    if (s.phase !== 'in_round' || s.turn.activeRowId === null) return;
    const i = findTurnIndexFrom(s.rows, s.rows.findIndex((r) => r.id === s.turn.activeRowId) + 1);
    this.stats.actions++;
    this.navigate(frame, setActiveParticipant(i >= 0 ? s.rows[i].id : null), 'next');
  }

  /** In-memory invariant of every iframe's local state. */
  checkLocalDecks(when: string) {
    for (const frame of this.frames) {
      for (const p of deckProblems(frame.store.getState().swade as never)) {
        const msg = `${frame.name} local (${when}): ${p}`;
        if (!this.violations.includes(msg)) this.violations.push(msg);
      }
    }
  }

  /** A GM adds a participant with a unique name. */
  add(frame: Frame, label = 'n') {
    const name = `${label}${this.nameCounter++}`;
    this.created.push({ name, frame, step: this.stepNo });
    this.act(frame, () => frame.store.dispatch(createParticipant({ name, type: 'NPC' }))); // an add in a round can take the turn
  }

  /** Tell one iframe its role, at once or (roleLag) after a random delay; newer changes win. */
  setFrameRole(frame: Frame, role: Frame['role']) {
    const seq = ++frame.roleSeq;
    const update = () => {
      if (frame.roleSeq !== seq || frame.role === role) return;
      frame.role = role;
      this.log.push(`role heard ${frame.name} ${role}`);
      for (const listener of [...frame.roleListeners]) listener();
    };
    if (this.options.roleLag) setTimeout(update, Math.floor(this.rnd() * 800));
    else update();
  }

  writeMode(): WriteMode {
    if (!this.options.faults || this.faultsOff) return 'ok';
    const x = this.rnd();
    return x < 0.7 ? 'ok' : x < 0.78 ? 'rateLimit' : x < 0.88 ? 'timeoutLands' : x < 0.95 ? 'timeoutLost' : 'reject';
  }

  /** The iframe becomes visible again (or gets focus): its engine reads the room. */
  wake(frame: Frame) {
    this.log.push(`wake ${frame.name}`);
    frame.deaf = false;

    for (const listener of [...frame.wakeListeners]) listener();
  }

  /** Deliver the next queued event to an iframe. `final`: no event is lost or coalesced. */
  deliver(frame: Frame, final = false) {
    if (this.options.coalesce && !this.faultsOff && !final && frame.queue.length > 1 && this.rnd() < 0.5) {
      frame.queue.splice(0, frame.queue.length - 1);
      frame.lastLoss = this.stepNo;
    }
    const event = frame.queue.shift();
    if (!event) return;
    if (this.options.drops && !this.faultsOff && !final && (frame.deaf || this.rnd() < 0.1)) {
      frame.lastLoss = this.stepNo;
      this.stats.outside++;
      this.log.push(`drop ${frame.name} ${idOf(parseEncounterState(event.metadata[STATE_KEY]))}`);
      return;
    }
    frame.received.push(event.metadata);
    for (const listener of [...frame.listeners]) listener(clone(event.metadata));
    const parsed = parseEncounterState(event.metadata[STATE_KEY]);
    if (parsed.kind === 'ok') frame.maxDelivered = Math.max(frame.maxDelivered, parsed.state.revision);
    this.trackClient(frame, parsed);
    frame.showsTooNew = parsed.kind === 'too-new' && frame.engine.getSnapshot().status === 'too-new';
    const local = frame.store.getState().swade;
    this.log.push(`deliver ${frame.name} ${idOf(parseEncounterState(event.metadata[STATE_KEY]))} -> ${local.revision}/${local.writerId}`);
  }

  /** Events handed to an iframe: a GM that gets a state without `client` after one with it must get the older-version notice. */
  trackClient(frame: Frame, parsed: ReturnType<typeof parseEncounterState>) {
    if (parsed.kind !== 'ok') return;
    if (parsed.client) frame.clients.aware = true;
    else if (frame.clients.aware && frame.role === 'GM') frame.clients.olderSeen = true;
  }

  remove(write: Write) {
    this.writes.splice(this.writes.indexOf(write), 1);
  }

  /** Advance one write: land it and/or settle its promise. `final` lets every write finish. */
  progress(write: Write, final: boolean) {
    const { mode } = write;
    if (mode === 'ok' || (final && mode === 'timeoutLands' && !write.rejected)) {
      if (!write.landed) {
        if (!this.apply(write.patch, write.frame, write.echo)) {
          this.stats.failures++;
          this.remove(write);
          write.reject({ error: { name: 'MetadataTooLarge' } });
          return;
        }
        write.landed = true;
        if (!final && this.rnd() < 0.5) return; // resolves in a later step
      }
      this.remove(write);
      // Without an echo, the writer still gets every event that landed before its write.
      if (!write.echo) while (write.frame.queue.length) this.deliver(write.frame);
      this.log.push(`resolve ${write.frame.name}`);
      write.resolve();
    } else if (mode === 'timeoutLands') {
      if (!write.rejected) {
        write.rejected = true;
        this.stats.failures++;
        this.log.push(`timeout ${write.frame.name} (lands later)`);
        write.reject(TIMEOUT());
        return;
      }
      this.remove(write);
      this.apply(write.patch, write.frame, write.echo);
    } else {
      this.remove(write);
      this.stats.failures++;
      this.log.push(`fail ${write.frame.name} ${mode}`);
      write.reject(mode === 'timeoutLost' ? TIMEOUT() : { error: { name: mode === 'rateLimit' ? 'RateLimitHit' : 'Unknown' } });
    }
  }

  settleRead(final: boolean, frame?: Frame) {
    const index = frame ? this.reads.findIndex((r) => r.frame === frame) : 0;
    if (index < 0) return;
    const [read] = this.reads.splice(index, 1);
    if (!read) return;
    if (read.fail && !final) read.reject(new Error('Message OBR_ROOM_GET_METADATA took longer than 5000ms to get a result'));
    else {
      read.frame.received.push(this.metadata);
      read.resolve(clone(this.metadata));
    }
  }

  async flushMicrotasks() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }

  /**
   * `strict`: every write sent so far lands, in order, and every event reaches every iframe, so
   * nobody acts or writes on a stale state. GMs still act concurrently: changes in the debounce of
   * several iframes are written from the same state. (A write from an older state that lands after
   * newer ones takes the room back, which rightly gives up navigation with the warning.)
   */
  async syncAll() {
    for (let i = 0; (this.writes.length || this.frames.some((f) => f.queue.length)) && i < 20; i++) {
      while (this.writes.length) this.progress(this.writes[0], false);
      for (const frame of this.frames) while (frame.queue.length) this.deliver(frame);
      await this.flushMicrotasks();
    }
  }

  async step() {
    this.stepNo++;
    if (this.options.strict) await this.syncAll();
    for (const frame of this.frames.filter((f) => f.wakeSoon)) {
      frame.wakeSoon = false;
      while (this.reads.some((r) => r.frame === frame)) this.settleRead(false, frame); // a wake read still pending
      await this.flushMicrotasks();
      this.wake(frame);
      this.settleRead(false, frame);
      await this.flushMicrotasks();
    }
    if (this.options.deaf && !this.frames.some((f) => f.deaf) && this.rnd() < 0.08) await this.deafEpisode();
    // `turns`: more GM actions (x = 0 is a GM change).
    const x = this.options.turns && this.rnd() < 0.15 ? 0 : this.rnd();
    // The UI and the context menus act only after the room was loaded and is usable.
    const actors = this.frames.filter(
      (f) => f.role === 'GM' && f.engine.getSnapshot().loaded && !['invalid', 'too-new'].includes(f.engine.getSnapshot().status)
    );
    if (x < 0.18 && actors.length) {
      const frame = this.pick(actors);
      if (this.options.strict) await this.syncAll();
      const state = frame.store.getState().swade;
      frame.undo.captureCheckpoint('change');
      if (this.options.addOnly) this.add(frame);
      else if (this.options.forward && frame !== this.frames[0]) this.follower(frame);
      else if (state.rows.length > 12 && this.options.forward) this.rich(frame);
      else if (state.rows.length > 12) { frame.resetAt.push(this.stepNo); this.act(frame, () => frame.store.dispatch(reset())); }
      else if (this.rnd() < 0.2) this.act(frame, () => frame.store.dispatch(setPrivacy(!state.settings.hideNpcFromPlayers)));
      // `forward`: no late joiner while cards are dealt or in a round (it changes the order Start
      // Round begins with, or who is still to act).
      else if (this.options.rich && (this.rnd() < 0.65 || (this.options.forward && (state.phase === 'cards_dealt' || state.phase === 'in_round')))) this.rich(frame);
      else this.add(frame);
      this.stats.actions++;
      this.log.push(`change ${frame.name} -> ${frame.store.getState().swade.revision}`);
    } else if (x < 0.45) {
      if (this.options.partition && this.rnd() < 0.05) { const f = this.pick(this.frames); if (this.cut.has(f)) this.cut.delete(f); else this.cut.add(f); }
      const waiting = this.frames.filter((f) => f.queue.length && !this.cut.has(f));
      if (waiting.length) this.deliver(this.pick(waiting));
    } else if (x < 0.62) {
      // `strict`: writes land in the order they were sent.
      if (this.writes.length) this.progress(this.options.strict ? this.writes[0] : this.pick(this.writes), false);
    } else if (x < 0.67) {
      this.settleRead(false);
    } else if (x < 0.8) {
      await vi.advanceTimersByTimeAsync(Math.floor(this.rnd() * 600));
    } else if (x < 0.86 && this.options.undo && actors.length) {
      const frame = this.pick(actors);
      this.stats.actions++;
      const undone = this.act(frame, () => frame.undo.performUndo());
      if (undone) frame.undoneAt.push(this.stepNo);
      this.log.push(`undo ${frame.name} ${undone}`);
    } else if (x < 0.89 && this.options.roles) {
      const browser = this.pick(this.browsers);
      browser.role = browser.role === 'GM' ? 'PLAYER' : 'GM';
      browser.roleChanged = true;
      this.stats.outside++;
      for (const frame of browser.frames) this.setFrameRole(frame, browser.role);
      this.log.push(`role ${browser.frames.map((f) => f.name)} ${browser.role}`);
    } else if (x < 0.92 && this.options.v1) {
      this.stats.outside++;
      this.v1Write();
    } else if (x < 0.92 && this.options.late && this.rnd() < 0.4) {
      this.stats.outside++;
      this.lateWrite();
    } else if (x < 0.92 && this.options.keys) {
      this.stats.outside++;
      const y = this.rnd();
      if (this.options.tooNew && y < 0.05) this.apply({ [STATE_KEY]: TOO_NEW }, null);
      else if (y < 0.15) this.apply({ [STATE_KEY]: undefined }, null);
      else if (this.options.invalid && y < 0.2) this.apply({ [STATE_KEY]: INVALID }, null);
      else if (y < 0.3) this.apply({ 'other.ext/big': 'x'.repeat(Math.floor(this.rnd() * 14000)) }, null);
      else this.apply({ 'other.ext/small': Math.floor(this.rnd() * 100) }, null);
    } else if (x < 0.95) {
      if (this.options.drops && this.rnd() < 0.5) {
        this.wake(this.pick(this.frames));
        await this.flushMicrotasks();
        return;
      }
      void this.pick(this.frames).engine.retry(); // the "Not saved – retry" chip
      // The gate's "Reset tracker" button for a GM that shows invalid room data.
      const invalid = this.frames.filter((f) => f.role === 'GM' && f.engine.getSnapshot().status === 'invalid');
      if (invalid.length && this.rnd() < 0.5) {
        const frame = this.pick(invalid);
        frame.resetAt.push(this.stepNo);
        this.act(frame, () => frame.store.dispatch(reset()));
        this.stats.actions++;
        this.log.push(`reset ${frame.name} (invalid)`);
      }
    }
    await this.flushMicrotasks();
    if (this.options.rich) this.checkLocalDecks(`step ${this.stepNo}`);
  }

  /**
   * Let every write finish and every event arrive (none lost); with `retry`, failed writes are
   * retried (the chip). Where events can be lost, every iframe also becomes visible again each
   * round (a wake read). Returns the number of rounds (10 s each) it took, or -1 when it did
   * not become quiet within MAX_QUIESCE_ROUNDS or wrote more than the write budget on the way.
   */
  async quiesce(retry = true): Promise<number> {
    for (let round = 1; round <= MAX_QUIESCE_ROUNDS; round++) {
      if ('other.ext/big' in this.metadata) this.apply({ 'other.ext/big': undefined }, null);
      while (this.reads.length) this.settleRead(true);
      while (this.writes.length) {
        if (this.stats.writes > this.writeBudget()) return -1; // a write loop: stop early
        this.progress(this.writes[0], true);
        await this.flushMicrotasks();
      }
      for (const frame of this.frames) while (frame.queue.length) this.deliver(frame, true);
      await this.flushMicrotasks();
      if (this.options.drops) {
        for (const frame of this.frames) this.wake(frame);
        await this.flushMicrotasks();
        while (this.reads.length) this.settleRead(true);
        await this.flushMicrotasks();
      }
      await vi.advanceTimersByTimeAsync(10_000);
      if (retry) for (const frame of this.frames) void frame.engine.retry();
      await this.flushMicrotasks();
      const idle = !this.writes.length && !this.reads.length && this.frames.every((f) => !f.queue.length);
      if (idle && vi.getTimerCount() === 0) return round;
    }
    return -1;
  }

  /**
   * After quiet: stop all faults (and coalescing), let one GM make one more change (a write
   * loop needs a trigger whose echoes all arrive), become quiet again, then wait a long time
   * while delivering everything and pressing every retry chip. No iframe may write then.
   */
  async quietWindow() {
    this.faultsOff = true;
    const actor = this.frames.find((f) => f.role === 'GM' && f.engine.getSnapshot().status === 'ready');
    if (actor) {
      this.add(actor, 'probe');
      this.stats.actions++;
      this.log.push(`probe ${actor.name}`);
      if ((await this.quiesce()) < 0) {
        this.violations.push(`did not become quiet after the probe change (${this.stats.writes} writes, budget ${this.writeBudget()})`);
        return;
      }
    }
    const before = this.stats.writes;
    for (let round = 0; round < 6; round++) {
      while (this.reads.length) this.settleRead(true);
      while (this.writes.length && this.stats.writes - before < 50) {
        this.progress(this.writes[0], true);
        await this.flushMicrotasks();
      }
      for (const frame of this.frames) while (frame.queue.length) this.deliver(frame, true);
      await this.flushMicrotasks();
      await vi.advanceTimersByTimeAsync(30_000);
      for (const frame of this.frames) void frame.engine.retry();
      await this.flushMicrotasks();
    }
    if (this.stats.writes !== before) this.violations.push(`write storm: ${this.stats.writes - before} writes in the quiet window`);
  }

  /**
   * Nobody pressed the retry chip: an iframe left in `error` still shows its own unsaved change
   * (the status and the change stay visible) and got the error notification.
   */
  checkStuckInError() {
    for (const frame of this.frames) {
      if (frame.engine.getSnapshot().status !== 'error' || !frame.engine.getSnapshot().loaded) continue;
      const local = frame.store.getState().swade;
      if (local.writerId !== frame.name) this.violations.push(`${frame.name} is in error without retry but shows ${local.revision}/${local.writerId}`);
      if (!frame.notes.some((n) => n.includes('could not be saved'))) this.violations.push(`${frame.name} is in error without the error notification`);
    }
  }

  /**
   * The "older version" notice: at most once per iframe; never without an older (v1) writer; and
   * a GM iframe that got a v1 state after a state of this app got it.
   */
  checkOlderClientNotice() {
    for (const frame of this.frames) {
      const count = frame.notes.filter((n) => n.includes('older version')).length;
      olderNotices += count;
      if (count > 1) this.violations.push(`${frame.name} got the older-version notice ${count} times`);
      if (count > 0 && !this.options.v1) this.violations.push(`${frame.name} got the older-version notice without an older writer`);
      if (count === 0 && frame.clients.olderSeen) this.violations.push(`${frame.name} got a v1 state after a current one but no older-version notice`);
    }
  }

  /** The total number of writes stays within the budget. */
  checkWriteBudget() {
    const budget = this.writeBudget();
    if (this.stats.writes > budget) {
      const { writes, actions, failures, outside } = this.stats;
      this.violations.push(`write storm: ${writes} writes > budget ${budget} (${actions} actions, ${failures} failures, ${outside} outside events, ${this.frames.length} iframes)`);
    }
  }

  /**
   * addOnly (N1): nobody removes a row, so a warning is justified only when a room value
   * handed to the iframe since its last warning (the one that caused it is among them) lacks a
   * row that iframe added before.
   */
  checkWarningJustified(frame: Frame, step: number) {
    const values = frame.received.splice(0).map((m) => parseEncounterState(m[STATE_KEY]));
    const mine = this.created.filter((c) => c.frame === frame && c.step <= step);
    const lacking = values.some((v) => v.kind !== 'ok' || mine.some((c) => !names(v.state).has(c.name)));
    if (!lacking) this.violations.push(`${frame.name} warned at step ${step} although no change was lost`);
  }

  /** Every participant a GM added is in the final state's lineage (the state and its stored ancestors). */
  checkNoActionLost(finalId: string) {
    const inLineage = new Set<string>();
    const visited = new Set<string>();
    for (let id: string | null = finalId; id && !visited.has(id); id = this.lineage.get(id)?.parent ?? null) {
      visited.add(id);
      for (const name of this.lineage.get(id)?.names ?? []) inLineage.add(name);
    }
    for (const { name, frame, step } of this.created) {
      if (inLineage.has(name) || frame.removedLocally.has(name)) continue;
      if ([...frame.warnedAt, ...frame.replacedAt].some((warned) => warned >= step) || this.lastOutsideWrite >= step) continue;
      this.violations.push(`${frame.name}'s ${name} (step ${step}) was lost without a warning`);
    }
  }

  /** Every iframe, players and demoted GMs included, shows the room's value. */
  check() {
    const room = parseEncounterState(this.metadata[STATE_KEY]);
    const roomJson = JSON.stringify(withoutParent(this.metadata[STATE_KEY]));
    const empty = content(initializeEmptyState());
    for (const frame of this.frames) {
      const local = frame.store.getState().swade;
      const { status } = frame.engine.getSnapshot();
      const label = `${frame.name} (${frame.browser.role}${frame.browser.roleChanged ? ', role changed' : ''}, ${status})`;
      if (frame.role !== frame.browser.role) this.violations.push(`${label} still thinks it is ${frame.role}`);
      if (room.kind === 'ok') {
        const same = local.revision === room.state.revision && local.writerId === room.state.writerId && JSON.stringify(encodeEncounterState(local)) === roomJson;
        if (!same) this.violations.push(`${label} shows ${local.revision}/${local.writerId}, room holds ${idOf(room)}`);
        else if (status !== 'ready') this.violations.push(`${label} shows the room state but status is ${status}`);
      } else if (room.kind === 'absent') {
        // Only possible when no GM is left: every iframe shows an empty tracker.
        if (status !== 'absent-player') this.violations.push(`${label}: room has no state`);
        if (content(local) !== empty) this.violations.push(`${label}: room has no state but it shows rows`);
      } else if (room.kind === 'too-new' && status !== 'too-new') {
        this.violations.push(`${label}: room holds a newer version`);
      }
    }
    if (room.kind === 'ok') this.checkNoActionLost(idOf(room));
    if (this.options.strict && !this.options.conflicts) {
      for (const frame of this.frames) for (const note of frame.notes) this.violations.push(`${frame.name} was told "${note}" (strict: no warning at all)`);
    }
    if (!this.options.faults && !this.options.roles && !this.options.keys && !this.options.v1 && !this.options.drops && !this.options.late) {
      // Without faults, role changes and outside writes, concurrency alone never warns
      // (an Undo whose snapshot met a concurrent change may: it is not replayed). Coalesced
      // events can leave a lineage unknown: then only "may have replaced" (nothing unsaved).
      // A keeper choice whose card a concurrent change took away is void on replay: "may have
      // replaced" (review 7), never the discard warning.
      for (const frame of this.frames) {
        for (const step of this.options.coalesce ? frame.warnedAt : [...frame.warnedAt, ...frame.replacedAt]) {
          const keptBefore = frame.replacedAt.includes(step) && frame.keptAt.some((kept) => kept <= step);
          if (!keptBefore && !frame.undoneAt.some((undo) => undo <= step)) this.violations.push(`${frame.name} warned at step ${step} without faults`);
        }
      }
    }
    if (room.kind === 'ok') {
      // The writer raises its state above every revision it received before its echo. With
      // coalesced events it cannot know a revision that never reached it.
      const writer = this.frames.find((f) => f.name === room.state.writerId);
      if (writer && !writer.browser.roleChanged && room.state.revision < writer.maxDelivered) {
        this.violations.push(`room revision ${room.state.revision} is below ${writer.maxDelivered}, which its writer received`);
      }
    }
  }
}

/**
 * Drive every source of randomness and time from the seed: Math.random (row ids, writer ids),
 * crypto (action seeds, undo ids), the clock and the timers. Returns the restore function.
 */
function seedGlobals(seed: number): () => void {
  vi.clearAllTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const rnd = prng(seed ^ 0x5bd1e995);
  const random = vi.spyOn(Math, 'random').mockImplementation(rnd);
  const fill = <T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rnd() * 256);
    }
    return array;
  };
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
  vi.stubGlobal('crypto', {
    getRandomValues: fill,
    randomUUID: () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`,
  });
  return () => {
    random.mockRestore();
    vi.unstubAllGlobals();
  };
}

async function run(seed: number, options: Options): Promise<Room> {
  const restore = seedGlobals(seed);
  try {
    return await runSeeded(seed, options);
  } finally {
    restore();
  }
}

async function runSeeded(seed: number, options: Options): Promise<Room> {
  const room = new Room(prng(seed), options);
  if (room.rnd() < 0.7) {
    const initial = { ...initializeEmptyState(), revision: 3, writerId: 'old' };
    room.metadata = { [STATE_KEY]: encodeEncounterState(initial) };
    room.lineage.set('3/old', { names: new Set(), parent: null, turn: turnOf(initial), writer: 'old', at: 0, moved: false, rows: new Set(), hash: 0, state: initial });
  }
  room.addBrowser('GM', 1 + Math.floor(room.rnd() * 3)); // popover, modal, background page
  if (options.gms) for (let g = 1; g < options.gms; g++) room.addBrowser('GM', 1 + Math.floor(room.rnd() * 2));
  else if (room.rnd() < 0.7) room.addBrowser('GM', 1 + Math.floor(room.rnd() * 2));
  room.addBrowser('PLAYER', 1);
  // `strict`: every iframe has loaded before play starts (a first read ahead of events still on
  // their way would make an iframe follow an older state afterwards).
  for (let i = 0; options.strict && room.reads.length && i < 10; i++) {
    while (room.reads.length) room.settleRead(false);
    await room.flushMicrotasks();
  }
  for (let i = 0; i < STEPS; i++) await room.step();
  room.cut.clear();
  // Nobody presses the retry chip: the system becomes quiet, and `error` stays visible.
  if ((await room.quiesce(false)) < 0) room.violations.push(`did not become quiet without retry (${room.stats.writes} writes, budget ${room.writeBudget()})`);
  room.checkStuckInError();
  const rounds = await room.quiesce();
  if (rounds < 0) room.violations.push(`did not become quiet (${room.stats.writes} writes, budget ${room.writeBudget()})`);
  else {
    maxRounds = Math.max(maxRounds, rounds);
    await room.quietWindow();
  }
  room.checkWriteBudget();
  room.checkOlderClientNotice();
  maxBudgetUse = Math.max(maxBudgetUse, room.stats.writes / room.writeBudget());
  room.check();
  room.checkLocalDecks('end');
  for (const frame of room.frames) {
    frame.engine.stop();
    frame.undo.destroy();
  }
  return room;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const CONFIGS: [string, Options][] = [
  ['no faults', { faults: false, noEcho: false, roles: false, keys: false, undo: true }],
  ['concurrent GMs only (no faults, no undo: no warning at all)', { faults: false, noEcho: false, roles: false, keys: false, undo: false }],
  ['write faults and missing echoes', { faults: true, noEcho: true, roles: false, keys: false, undo: true }],
  ['other keys, deletion and size limit', { faults: false, noEcho: false, roles: false, keys: true, undo: false , seedShare: 0.5}],
  ['role changes (each iframe hears them late)', { faults: true, noEcho: false, roles: true, keys: false, undo: true, roleLag: true }],
  ['coalesced events', { faults: true, noEcho: false, roles: false, keys: false, undo: true, coalesce: true }],
  ['newer app version', { faults: true, noEcho: false, roles: false, keys: true, undo: true, tooNew: true, invalid: true }],
  ['R6 rich, two-three GMs, no faults', { faults: false, noEcho: false, roles: false, keys: false, undo: true, rich: true, seedShare: 0.5 }],
  ['R10 strict: forward play, two-three GMs, no faults (no warning at all)', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, forward: true, strict: true, seedShare: 0.5 }],
  ['R11 every action (Previous, Act Now, Hold, Lose Turn, late joiners), turns, three GMs, no faults (content warnings only)', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, turns: true, strict: true, conflicts: true, gms: 3, seedShare: 0.5 }],
  ['R11 every action, turns, two GMs, no faults (content warnings only)', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, turns: true, strict: true, conflicts: true, gms: 2, seedShare: 0.5 }],
  ['R10 strict: forward play, turns, three GMs (no warning at all)', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, turns: true, forward: true, strict: true, gms: 3, seedShare: 0.5 }],
  ['R6 rich, three GMs, no faults, no undo', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, gms: 3 , seedShare: 0.5}],
  ['R6 rich, three GMs, partitions', { faults: false, noEcho: false, roles: false, keys: false, undo: true, rich: true, gms: 3, partition: true , seedShare: 0.5}],
  ['R6 rich, three GMs, partitions + faults', { faults: true, noEcho: true, roles: false, keys: false, undo: true, rich: true, gms: 3, partition: true , seedShare: 0.5}],
  ['R6 rich everything', { faults: true, noEcho: true, roles: true, keys: true, undo: true, coalesce: true, roleLag: true, tooNew: true, invalid: true, rich: true, gms: 3, partition: true , seedShare: 0.5}],
  ['released v1 GM writes too', { faults: false, noEcho: false, roles: false, keys: false, undo: true, rich: true, v1: true , seedShare: 0.5}],
  ['R8: an older app (v1) copies stale states, rich, two GMs', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, gms: 2, v1: true, v1Stale: true , seedShare: 0.5}],
  ['R8: stale v1 copies, lost events, rich, two GMs', { faults: false, noEcho: false, roles: false, keys: false, undo: true, rich: true, gms: 2, v1: true, v1Stale: true, drops: true , seedShare: 0.5}],
  ['R9: late writes from older states (known lineage), turns, two GMs', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, turns: true, gms: 2, late: true, seedShare: 0.5 }],
  ['R9: late writes, lost events (unknown lineage), turns, two GMs', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, turns: true, gms: 2, late: true, drops: true, seedShare: 0.5 }],
  ['R9: deaf iframes woken after their own Next (unknown lineage, unsaved), turns, two GMs', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, turns: true, gms: 2, drops: true, deaf: true }],
  ['R9: lost events, turns, stale v1 copies, three GMs', { faults: false, noEcho: false, roles: false, keys: false, undo: false, rich: true, turns: true, gms: 3, drops: true, v1: true, v1Stale: true , seedShare: 0.5}],
  ['lost events and wake reads', { faults: true, noEcho: true, roles: false, keys: false, undo: true, drops: true }],
  ['R6 rich, lost events, no other faults', { faults: false, noEcho: false, roles: false, keys: false, undo: true, rich: true, gms: 3, drops: true , seedShare: 0.5}],
  ['N1: lost events and wake reads, adds only (no needless warning)', { faults: false, noEcho: false, roles: false, keys: false, undo: false, drops: true, addOnly: true, seedShare: 0.5 }],
  ['N1: lost events, adds only, three GMs, partitions (no needless warning)', { faults: false, noEcho: false, roles: false, keys: false, undo: false, drops: true, addOnly: true, gms: 3, partition: true , seedShare: 0.5}],
  ['everything', { faults: true, noEcho: true, roles: true, keys: true, undo: true, coalesce: true, roleLag: true, tooNew: true, invalid: true, drops: true }],
];

describe('sync fuzz: random interleavings of iframes, GMs and a player', () => {
  for (const [name, options] of CONFIGS) {
    it(`${name} (${env.SYNC_FUZZ_SEEDS ? SEEDS : Math.round(SEEDS * (options.seedShare ?? 1))} seeds)`, async () => {
      maxRounds = 0;
      maxBudgetUse = 0;
      olderNotices = 0;
      traceCounts.replayed = traceCounts.dropped = 0;
      const failures: string[] = [];
      const seeds = env.SYNC_FUZZ_SEEDS ? SEEDS : Math.round(SEEDS * (options.seedShare ?? 1));
      for (let seed = ONLY_SEED ?? 1; seed <= (ONLY_SEED ?? seeds); seed++) {
        const room = await run(seed * 7919 + name.length, options);
        if (room.violations.length) {
          failures.push(`seed ${seed}: ${room.violations.join(' | ')}`);
          // SYNC_FUZZ_LOG=1 logs the first failing seed; SYNC_FUZZ_LOG=<n> logs seed n.
          if (env.SYNC_FUZZ_LOG && (env.SYNC_FUZZ_LOG === '1' ? failures.length === 1 : env.SYNC_FUZZ_LOG === String(seed))) console.log(room.log.join('\n'));
        }
      }
      if (env.SYNC_FUZZ_STATS) console.log(`${name}: quiet after <= ${maxRounds} rounds, writes <= ${(maxBudgetUse * 100).toFixed(0)}% of budget, navigation replayed ${traceCounts.replayed}, dropped ${traceCounts.dropped}`);
      expect(failures.slice(0, 5), `${failures.length}/${seeds} seeds failed`).toEqual([]);
      // A v1 writer after this app's writes is noticed (in some seeds at least).
      if (options.v1 && !ONLY_SEED) expect(olderNotices).toBeGreaterThan(0);
    }, 600_000);
  }
});

describe('fuzz harness', () => {
  it('a seed reproduces exactly (same log, same stored states)', async () => {
    const options = CONFIGS.find(([name]) => name === 'everything')![1];
    const first = await run(4242, options);
    const second = await run(4242, options);
    expect(first.log.length).toBeGreaterThan(100);
    expect(second.log).toEqual(first.log);
  });

  it('an iframe that misses a room event stays stale until it becomes visible again', async () => {
    const room = new Room(prng(1), { faults: false, noEcho: false, roles: false, keys: false, undo: false, drops: true });
    room.stats.actions = 1000;
    room.metadata = { [STATE_KEY]: encodeEncounterState({ ...initializeEmptyState(), revision: 5, writerId: 'old' }) };
    room.addBrowser('GM', 1);
    room.addBrowser('PLAYER', 1);
    while (room.reads.length) room.settleRead(true);
    await room.flushMicrotasks();
    const [gm, player] = room.frames;
    gm.store.dispatch(createParticipant({ name: 'A', type: 'NPC' }));
    await vi.advanceTimersByTimeAsync(100);
    room.progress(room.writes[0], true);
    player.queue.length = 0; // the player's event is lost
    while (gm.queue.length) room.deliver(gm, true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(player.store.getState().swade.rows).toEqual([]);

    room.wake(player);
    while (room.reads.length) room.settleRead(true);
    await room.flushMicrotasks();
    expect(player.store.getState().swade.rows.map((r) => r.name)).toEqual(['A']);
  });
});

describe('sync orderings found by the fuzz (review 3)', () => {
  const quiet: Options = { faults: false, noEcho: false, roles: false, keys: false, undo: false };

  /** Two GMs, loaded from a room at revision 5. */
  async function twoGms() {
    const room = new Room(prng(1), quiet);
    room.stats.actions = 1000;
    room.metadata = { [STATE_KEY]: encodeEncounterState({ ...initializeEmptyState(), revision: 5, writerId: 'old' }) };
    room.addBrowser('GM', 1);
    room.addBrowser('GM', 1);
    while (room.reads.length) room.settleRead(true);
    await room.flushMicrotasks();
    const [a, b] = room.frames;
    return { room, a, b };
  }

  /** Let both debounces fire; returns each frame's pending write. */
  async function pendingWrites(room: Room, ...frames: Frame[]) {
    await vi.advanceTimersByTimeAsync(100);
    return frames.map((f) => room.writes.find((w) => w.frame === f)!);
  }

  function land(room: Room, write: Write) {
    room.apply(write.patch, write.frame);
    write.landed = true;
  }

  async function resolve(room: Room, write: Write) {
    room.remove(write);
    write.resolve();
    await room.flushMicrotasks();
  }

  const rows = (s: EncounterState) => s.rows.map((r) => r.name);
  const roomState = (room: Room) => {
    const parsed = parseEncounterState(room.metadata[STATE_KEY]);
    if (parsed.kind !== 'ok') throw new Error(parsed.kind);
    return parsed.state;
  };

  it('R3-S1: a foreign state that arrives between our resolve and our echo does not hide our write (both changes kept)', async () => {
    const { room, a, b } = await twoGms();
    b.store.dispatch(createParticipant({ name: 'B', type: 'PC' }));
    a.store.dispatch(createParticipant({ name: 'A', type: 'PC' }));
    const [wa, wb] = await pendingWrites(room, a, b);
    land(room, wb);
    land(room, wa); // A's write lands last: the room holds A's state
    await resolve(room, wa);
    room.deliver(a); // B's state reaches A after the resolve
    room.deliver(a); // then A's own echo
    await room.quiesce();

    // B's change was overwritten by A's write: B replays it on A's state.
    expect(rows(roomState(room)).sort()).toEqual(['A', 'B']);
    expect(content(a.store.getState().swade)).toBe(content(roomState(room)));
    expect(content(b.store.getState().swade)).toBe(content(roomState(room)));
    expect([...a.notes, ...b.notes]).toEqual([]);
  });

  it('R3-S2: a change after adopting a lower revision never reuses an identity we already wrote', async () => {
    const { room, a, b } = await twoGms();
    b.store.dispatch(createParticipant({ name: 'B', type: 'PC' })); // 6/B
    a.store.dispatch(createParticipant({ name: 'A1', type: 'PC' }));
    a.store.dispatch(createParticipant({ name: 'A2', type: 'PC' })); // 7/A
    const [wa, wb] = await pendingWrites(room, a, b);
    land(room, wb);
    land(room, wa);
    await resolve(room, wa);
    room.deliver(a); // 6/B arrives before A's echo
    a.store.dispatch(createParticipant({ name: 'A3', type: 'PC' }));
    expect(a.store.getState().swade.revision).toBeGreaterThan(7);
    await room.quiesce();

    expect(rows(roomState(room))).toContain('A3');
    for (const f of [a, b]) expect(content(f.store.getState().swade)).toBe(content(roomState(room)));
  });

  it('R3-S4: our write that lands after a higher foreign revision is written again above it', async () => {
    const { room, a, b } = await twoGms();
    for (let i = 0; i < 5; i++) b.store.dispatch(setPrivacy(i % 2 === 1)); // 10/B
    const foreignRevision = b.store.getState().swade.revision;
    a.store.dispatch(createParticipant({ name: 'A', type: 'PC' })); // 6/A
    expect(foreignRevision).toBe(10);
    const [wa, wb] = await pendingWrites(room, a, b);
    land(room, wb);
    land(room, wa); // the room now holds 6/A after 10/B
    expect(roomState(room).revision).toBe(6);
    await resolve(room, wa);
    await room.quiesce();

    expect(roomState(room).revision).toBeGreaterThan(10);
    expect(rows(roomState(room))).toEqual(['A']);
    expect(a.store.getState().swade.revision).toBe(roomState(room).revision);
  });

  it('an older own write that times out and lands after our newer write is overwritten again', async () => {
    const { room, a } = await twoGms();
    a.store.dispatch(createParticipant({ name: 'first', type: 'PC' }));
    const [w1] = await pendingWrites(room, a);
    room.remove(w1);
    w1.reject(TIMEOUT()); // reported as failed, but the host applies it later
    await room.flushMicrotasks();
    await vi.advanceTimersByTimeAsync(600); // retry of the same state
    const [retry] = await pendingWrites(room, a);
    land(room, retry);
    await resolve(room, retry);
    a.store.dispatch(createParticipant({ name: 'second', type: 'PC' }));
    const [w2] = await pendingWrites(room, a);
    land(room, w2);
    await resolve(room, w2);
    while (a.queue.length) room.deliver(a); // echoes of "first" and "second"
    room.apply(w1.patch, a); // the timed-out attempt lands last
    await room.quiesce();

    expect(rows(roomState(room))).toEqual(['first', 'second']);
    expect(a.store.getState().swade.revision).toBe(roomState(room).revision);
  });
});

describe('review 6 deterministic', () => {
  const quiet: Options = { faults: false, noEcho: false, roles: false, keys: false, undo: false };
  const roomRaw = (room: Room) => room.metadata[STATE_KEY] as Record<string, unknown>;
  const rowsOf = (s: EncounterState) => s.rows.map((r) => r.name);
  async function settle(room: Room) {
    while (room.reads.length) room.settleRead(true);
    await room.flushMicrotasks();
  }

  it('R6-a: a stored parent counts only for the state it was written with', () => {
    const state = { ...initializeEmptyState(), revision: 7, writerId: 'w0' };
    const raw = encodeEncounterState(state, { revision: 6, writerId: 'w1' }) as Record<string, unknown>;
    const parse = (value: unknown) => {
      const parsed = parseEncounterState(value);
      return parsed.kind === 'ok' ? parsed.parent : parsed.kind;
    };
    expect(parse(raw)).toEqual({ revision: 6, writerId: 'w1' });
    expect(parse({ ...raw, revision: 8 })).toBeNull(); // copied by a writer that keeps unknown keys
    expect(parse({ ...raw, version: 1, revision: 8 })).toBeNull(); // the released v1 app
    expect(parse({ ...raw, parent: { revision: 6, writerId: 'w1' } })).toBeNull(); // not bound
  });

  it('R6-a: a v1 client write keeps our stale parent: it is ignored, our actions are not replayed twice', async () => {
    const room = new Room(prng(1), quiet);
    room.stats.actions = 1000;
    room.metadata = { [STATE_KEY]: encodeEncounterState({ ...initializeEmptyState(), revision: 5, writerId: 'old' }) };
    room.addBrowser('GM', 1);
    await settle(room);
    const [a] = room.frames;
    a.store.dispatch(createParticipant({ name: 'X', type: 'NPC' }));
    await room.quiesce();
    // A v1 (HEAD) client adopts the room value with {...raw}, keeps writerId/parent, sets version 1, revision + 1.
    const v1 = clone(roomRaw(room));
    v1.version = 1;
    v1.revision = (v1.revision as number) + 1;
    (v1.rows as Record<string, unknown>[])[0].onHold = true;
    room.apply({ [STATE_KEY]: v1 }, null);
    await room.quiesce();
    const ids = (roomRaw(room).rows as { id: string }[]).map((r) => r.id);
    expect(ids).toHaveLength(1);
    expect(room.violations).toEqual([]);
    // Without a lineage A cannot tell whether the v1 state includes its saved change.
    expect(a.notes.filter((n) => n.includes('discarded'))).toEqual([]);
  });

  it('R6-b: a GM iframe that loads while the key is absent writes parent 0/"": others do not replay older actions onto it', async () => {
    const room = new Room(prng(1), quiet);
    room.stats.actions = 1000;
    room.metadata = { [STATE_KEY]: encodeEncounterState({ ...initializeEmptyState(), revision: 5, writerId: 'old' }) };
    room.addBrowser('GM', 1);
    await settle(room);
    const [a] = room.frames;
    a.store.dispatch(createParticipant({ name: 'X', type: 'NPC' }));
    a.store.dispatch(createParticipant({ name: 'Y', type: 'NPC' }));
    await room.quiesce();
    room.apply({ [STATE_KEY]: undefined }, null); // e.g. a v1 Full Reset
    room.addBrowser('GM', 1); // a modal / second GM opens now
    await settle(room);
    await vi.advanceTimersByTimeAsync(100);
    await room.quiesce();
    const parsed = parseEncounterState(room.metadata[STATE_KEY]);
    expect(parsed.kind === 'ok' && rowsOf(parsed.state)).toEqual([]);
  });

  it('R6-c: more than 50 unsaved actions, then a foreign state: the oldest is not lost without a warning', async () => {
    const room = new Room(prng(1), quiet);
    room.stats.actions = 1000;
    room.metadata = { [STATE_KEY]: encodeEncounterState({ ...initializeEmptyState(), revision: 5, writerId: 'old' }) };
    room.addBrowser('GM', 1);
    room.addBrowser('GM', 1);
    await settle(room);
    const [a, b] = room.frames;
    a.store.dispatch(createParticipant({ name: 'first', type: 'NPC' }));
    for (let i = 0; i < 50; i++) a.store.dispatch(setPrivacy(i % 2 === 0 ? false : true));
    // A's writes fail (non-retryable), status error.
    for (let k = 0; k < 10; k++) {
      await vi.advanceTimersByTimeAsync(100);
      for (const w of room.writes.filter((w) => w.frame === a)) {
        room.remove(w);
        w.reject({ error: { name: 'Unknown' } });
      }
      await room.flushMicrotasks();
    }
    expect(a.engine.getSnapshot().status).toBe('error');
    b.store.dispatch(createParticipant({ name: 'B', type: 'NPC' }));
    await vi.advanceTimersByTimeAsync(100);
    room.log.push('--- B write');
    const wb = room.writes.find((w) => w.frame === b)!;
    room.progress(wb, true);
    await room.flushMicrotasks();
    room.log.push('--- deliver to A');
    while (a.queue.length) room.deliver(a);
    await room.flushMicrotasks();
    await room.quiesce();
    const parsed = parseEncounterState(room.metadata[STATE_KEY]);
    const final = parsed.kind === 'ok' ? rowsOf(parsed.state) : [];
    const warned = a.notes.some((n) => n.includes('discarded'));
    expect(final.includes('first') || warned).toBe(true);
  });
});

describe('review 6 coalesced', () => {
  it('R6-d: two foreign writes coalesced into one event: a GM with no unsaved change is not told it was discarded', async () => {
    const room = new Room(prng(1), { faults: false, noEcho: false, roles: false, keys: false, undo: false });
    room.stats.actions = 1000;
    room.metadata = { [STATE_KEY]: encodeEncounterState({ ...initializeEmptyState(), revision: 5, writerId: 'old' }) };
    room.addBrowser('GM', 1);
    room.addBrowser('GM', 1);
    while (room.reads.length) room.settleRead(true);
    await room.flushMicrotasks();
    const [a, b] = room.frames;
    a.store.dispatch(createParticipant({ name: 'A', type: 'NPC' }));
    await room.quiesce();
    for (const name of ['B1', 'B2']) {
      b.store.dispatch(createParticipant({ name, type: 'NPC' }));
      await vi.advanceTimersByTimeAsync(100);
      room.progress(room.writes.find((w) => w.frame === b)!, true);
      await room.flushMicrotasks();
    }
    a.queue.splice(0, a.queue.length - 1); // host coalesces: A gets only the latest value
    room.deliver(a);
    await room.flushMicrotasks();
    // The lineage is unknown (B1 never reached A). A checks which of its actions B2 includes
    // (N1): its saved add is there, so A follows B2 with no warning at all.
    expect(a.notes).toEqual([]);
    expect([...names(a.store.getState().swade)].sort()).toEqual(['A', 'B1', 'B2']);
  });
});
