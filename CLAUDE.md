# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

This project uses Yarn as the package manager:

- **Install dependencies**: `yarn`
- **Production build**: `yarn build` (`tsc && vite build`)
- **Lint and type check**: `yarn lint` (`eslint` + `tsc --noEmit`)
- **Tests**: `yarn test` (Vitest, jsdom); `yarn test:watch` for watch mode
- **Preview build**: `yarn preview`

Rules:

- The dev server is always running. Never run `yarn dev` yourself.
- Never run `tsc -b`. Use `yarn lint` or `yarn build` for type checks.
- After changes, `yarn lint && yarn test && yarn build` must pass (CI runs the same).

## Project Overview

SWADE Initiative Tracker: an Owlbear Rodeo (OBR) extension for Savage Worlds Action Deck initiative (54 cards: 52 + 2 Jokers).

Tech stack: React 19, TypeScript, Vite 8, MUI 9, Redux Toolkit, `@owlbear-rodeo/sdk` 3.1.0, Vitest + Testing Library.

## Architecture

Full description: [docs/app-owlbear-integration.md](docs/app-owlbear-integration.md). General OBR platform notes: [docs/owlbear-platform.md](docs/owlbear-platform.md).

- **Entry points**: action popover `/` (`index.html` → `src/main.tsx`), modals `/?view=add-participant` and `/?view=card-chooser&participantId=…`, background page `/background.html` (`src/background.ts`, registers the token context menus). Each is a separate iframe with its own store and sync engine.
- **Shared state**: one `EncounterState` (v2) in **room metadata** (not scene metadata), key `rodeo.owlbear.swade-initiative/state`. Room metadata has 16 kB for all extensions.
- **Sync**: each state has an identity `(revision, writerId)`. The root reducer stamps every local change centrally (reducers never touch `revision`). Each written state also stores `parent` (stored form only), the room state it was made from. Clients follow the room's last write. The engine logs its own actions (`subscribeActions`); when a room state misses some of them (a concurrent GM write), it replays them on top of that state and writes the result. Unknown lineage, an Undo (`restoreSnapshot`), a replay that throws, or a client that may not write fall back to adopting the room state with one "change discarded" warning. Only GMs write. No write after a failed read. Writes are debounced, serial, and retried with backoff; a GM can also click the "Not saved – retry" chip (`retrySync()`). A size guard warns at 10 kB and refuses writes over the budget. Call `flushSync()` before an iframe closes.
- **Undo**: per-tab stack in sessionStorage (`swade-undo-v2-<roomId>`), shared by the iframes of one tab (popover, modals, background), kept on reload, not shared with other tabs. Siblings re-read it on the `storage` event and a tab-scoped `BroadcastChannel`. Old localStorage histories are removed on start. Undo only while the room still holds the state the last action made. After a rebase, the top checkpoint moves onto the other GM's state (`rebaseOrigins`), so Undo keeps that change. Call `captureCheckpoint()` and then dispatch in the same synchronous task (no `await` in between).
- **Privacy**: UI-only. Players with privacy on see only revealed rows and no deck counts (any count would let them count hidden rows).

### EncounterState (v2)

```typescript
interface EncounterState {
  version: 2;
  round: number;
  phase: 'setup' | 'between_rounds' | 'cards_dealt' | 'in_round';
  deck: {
    remaining: CardId[]; inPlay: CardId[]; discard: CardId[]; reshuffleAfterRound: boolean;
    jokersDealtThisRound?: number; // Joker deals this round; absent = 0, only in cards_dealt / in_round
  };
  rows: ParticipantRow[];   // display order; a row may carry actNowTurn?: true (Act Now turn without a card)
  turn: { activeRowId: string | null };
  settings: { hideNpcFromPlayers: boolean };
  revision: number;
  writerId: string;
}
```

To change the stored shape: bump `CURRENT_STATE_VERSION`, add a pure migration in `src/store/migrations.ts`, keep the codec output readable by older clients when possible, and add tests.

## Module List

- `src/main.tsx` – React root, `PluginGate`, theme
- `src/App.tsx` – store provider, error boundary, `SyncStatusGate`, undo provider, view routing by `?view=`
- `src/background.ts` – background page: own sync, context menu click handling
- `src/contextMenu.ts` – menu definitions (fixed ids), token name / image helpers
- `src/InitiativeTracker.tsx` – popover layout, role tracking
- `src/PluginThemeProvider.tsx` – MUI theme from the OBR theme
- `src/getPluginId.ts` – `rodeo.owlbear.swade-initiative/<path>` ids
- `src/store/types.ts` – data types
- `src/store/store.ts` – store singleton, stamping reducer, `startSync`, `flushSync`, `useSyncStatus`
- `src/store/syncEngine.ts` – room metadata sync, action log and rebase, retries, size guard
- `src/store/stateCodec.ts` – parse / encode / measure stored state
- `src/store/migrations.ts` – versioned migrations
- `src/store/initialState.ts` – fresh encounter
- `src/store/swadeSlice.ts` – reducers (deal, sort, turns, hold, Act Now, card chooser)
- `src/store/selectors.ts` – derived state, privacy and turn selectors
- `src/store/localUndoStore.ts` – undo stack
- `src/store/hooks.ts` – typed Redux hooks
- `src/contexts/UndoContext*.ts(x)`, `src/hooks/useUndo.ts` – undo React API
- `src/hooks/useObrPanelHeight.ts` – popover height
- `src/components/` – `HeaderBar`, `ParticipantList`, `ParticipantRow`, `RowAction`, `ControlBar`, `ActionCard`, `ParticipantAvatar`, `AddParticipantModal`, `CardChooserModal`, `ConfirmDialog`, `SyncStatusGate`, `SyncIndicator`, `UndoButton`, `AppErrorBoundary`, `PluginGate`, phase messages
- `src/utils/` – card ids, card scores, card styles, Fisher–Yates shuffle
- `src/test/` – OBR mock (`obrMock.ts`) and test setup

## SWADE Rules

- Order: Jokers (Black > Red), then Ace to 2, then suit (Spades > Hearts > Diamonds > Clubs).
- The deck reshuffles after any round with a Joker.
- Held rows are not dealt a card and are skipped by Start Round / Next / Previous. Removing the active row makes the next row that can act active (no wrap to the top). During a round with no active row, Next is off and Previous steps back to the last row that can act. Act Now puts a held row before or after the active row and reveals it. Lose Turn during a round moves the row directly above the active row and discards its card.
- During a round, late joiners and keeper changes are placed only among rows that have not acted. No full re-sort.
- Replacement draws: the GM chooses the keeper from all candidates.

## Testing

Unit and component tests use the OBR mock in `src/test/obrMock.ts` (multi-client hub, failure injection, room size limit).

Manual testing in an OBR dev room is still needed for: multi-client sync, two GMs acting at the same time (merge, Undo after a merge, mixed app versions), GM/player role switching and privacy, modal close vs write, context menus without the popover opened, the room size limit, and a v1 client's Full Reset (deletes the key).

## References

- OBR documentation is locally available in `~/owlbear-scrape/out/md/`.
