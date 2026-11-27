// RTK store, revision stamping and the per-iframe sync engine.
import { useSyncExternalStore } from 'react';
import { configureStore, type Middleware, type Reducer, type UnknownAction } from '@reduxjs/toolkit';
import OBR from '@owlbear-rodeo/sdk';
import { swadeSlice, setEncounterState } from './swadeSlice';
import type { EncounterState } from './types';
import { createSyncEngine, RETRY_DELAYS_MS, type SyncSnapshot } from './syncEngine';

export interface AppStoreOptions {
  /** Id of this iframe; stamped on every local change. */
  writerId: string;
  /** Highest revision seen in the room; local changes are stamped above it. */
  getMinRevision: () => number;
}

/**
 * Wrap the slice reducer: any action that changes the state (except the sync-only
 * setEncounterState) gets revision = max(prev, minRevision) + 1 and this writerId.
 */
export function createStampingReducer({ writerId, getMinRevision }: AppStoreOptions): Reducer<EncounterState, UnknownAction> {
  return (state, action) => {
    const next = swadeSlice.reducer(state, action);
    if (state === undefined || next === state || setEncounterState.match(action)) return next;
    return { ...next, revision: Math.max(state.revision, getMinRevision()) + 1, writerId };
  };
}

/**
 * The RTK store. `subscribeActions` reports every local action that changed the state
 * (not the sync-only setEncounterState) with the state before it, after the store
 * listeners ran: the sync engine
 * keeps them to replay them on top of a concurrent change from another GM.
 */
export function createAppStore(options: AppStoreOptions) {
  const actionListeners = new Set<(action: UnknownAction, before: EncounterState) => void>();
  const reportActions: Middleware<object, { swade: EncounterState }> = (api) => (next) => (action) => {
    const before = api.getState().swade;
    const result = next(action);
    if (api.getState().swade !== before && !setEncounterState.match(action)) {
      for (const listener of [...actionListeners]) listener(action as UnknownAction, before);
    }
    return result;
  };
  const store = configureStore({
    reducer: { swade: createStampingReducer(options) },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(reportActions),
  });
  return Object.assign(store, {
    subscribeActions(listener: (action: UnknownAction, before: EncounterState) => void): () => void {
      actionListeners.add(listener);
      return () => {
        actionListeners.delete(listener);
      };
    },
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];

/** Short random id, unique per iframe (popover, each modal, background). */
export function createWriterId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- singleton for this iframe ----------

export const writerId = createWriterId();

// ---------- player role: one OBR subscription per iframe ----------
// The SDK's player unsubscribe message carries no listener id, so several
// player.onChange subscriptions in one iframe could cancel each other. Everything in
// this iframe (sync engine, React components) reads the role from here instead.

export type Role = 'GM' | 'PLAYER';

let role: Role = 'PLAYER';
const roleListeners = new Set<() => void>();
let roleWatch: { stop: () => void; loaded: Promise<void> } | null = null;

const retryDelay = (attempt: number) =>
  new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]));

function setRole(next: Role) {
  if (next === role) return;
  role = next;
  for (const listener of [...roleListeners]) listener();
}

/** Subscribe to player.onChange and read the role (retried until it succeeds). */
function watchRole() {
  let active = true;
  let eventSeen = false;
  const unsubscribe = OBR.player.onChange((player) => {
    eventSeen = true;
    setRole(player.role);
  });
  const loaded = (async () => {
    for (let attempt = 0; active; attempt++) {
      try {
        const read = await OBR.player.getRole();
        if (active && !eventSeen) setRole(read); // an event is newer than the read
        return;
      } catch {
        await retryDelay(attempt);
      }
    }
  })();
  return {
    stop: () => {
      active = false;
      unsubscribe();
    },
    loaded,
  };
}

/** This player's role as last seen ('PLAYER' until it was read). */
export const getRole = (): Role => role;

/**
 * Listen for role changes. The first listener starts the iframe's one OBR subscription;
 * it stops when the last listener leaves (startSync keeps one for the iframe's lifetime).
 */
export function subscribeRole(listener: () => void): () => void {
  roleListeners.add(listener);
  const watch = (roleWatch ??= watchRole());
  return () => {
    roleListeners.delete(listener);
    if (roleListeners.size === 0 && roleWatch === watch) {
      watch.stop();
      roleWatch = null;
    }
  };
}

/**
 * Calls the listener when room events may have been missed: the iframe becomes visible
 * again, gets focus, or the browser comes back online. The sync engine then reads the room.
 */
export function subscribeWake(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const onVisibility = () => {
    if (document.visibilityState !== 'hidden') listener();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', listener);
  window.addEventListener('online', listener);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', listener);
    window.removeEventListener('online', listener);
  };
}

export const store = createAppStore({
  writerId,
  getMinRevision: () => syncEngine.getMaxSeenRevision(),
});

export const syncEngine = createSyncEngine({
  store,
  obr: OBR,
  writerId,
  isGm: () => role === 'GM',
  subscribeRole,
  subscribeWake,
});

let startPromise: Promise<void> | null = null;

/** Start syncing this iframe's store with the room. Call after OBR.onReady; idempotent. */
export function startSync(): Promise<void> {
  if (!startPromise) {
    startPromise = (async () => {
      subscribeRole(() => {}); // keeps the role watch for the iframe's lifetime
      await roleWatch?.loaded;
      await syncEngine.start();
    })();
  }
  return startPromise;
}

/**
 * Write any pending local change now and wait for it (e.g. before OBR.modal.close).
 * Resolves to true when the state is saved in the room (or nothing was pending), false
 * when it is not: the write failed, the state is too large, or this player is not a GM.
 */
export function flushSync(): Promise<boolean> {
  return syncEngine.flush();
}

/** Retry a failed or too-large write now (GM only; no-op otherwise). */
export function retrySync(): Promise<void> {
  return syncEngine.retry();
}

/** Current sync status of this iframe (re-renders on change). */
export function useSyncStatus(): SyncSnapshot {
  return useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);
}

if (import.meta.env.DEV) {
  (window as typeof window & { __REDUX_STORE__: AppStore }).__REDUX_STORE__ = store;
}
