# SWADE Initiative Tracker for Owlbear Rodeo

A card-based initiative tracker extension for Savage Worlds Adventure Edition (SWADE) games in Owlbear Rodeo. This extension manages initiative using a standard 54-card deck, following SWADE's unique card-based initiative system.

![Example](/public/docs/header.jpg)

## Overview

This extension brings SWADE's action card initiative system to Owlbear Rodeo, providing:
- **Automated card dealing and sorting** following SWADE rules
- **Shared view** for GMs and players with privacy controls
- **Hold and interrupt mechanics** for tactical combat
- **Token integration** for quick combatant management
- **Undo system** for mistake correction

The design philosophy is to feel like a shared deck at a physical table, removing only the logistical pain while preserving the tactile, analog feel of SWADE combat.

## Add to Owlbear Rodeo

To add this extension to your Owlbear Rodeo room:

1. Open your Owlbear Rodeo room
2. Click the **Extensions** menu in the settings menu
3. Press the **Add Custom Extension** button
4. Enter this manifest URL: `https://swade-initiative.ewal.app/manifest.json`
5. Click **Add**


## Features

### Core Initiative System
- **54-card Action Deck**: Standard deck with 2 Jokers, automatically shuffled and managed
- **SWADE Sorting**: Proper initiative order (Jokers → Ace to 2, with suit precedence: Spades > Hearts > Diamonds > Clubs)
- **Automatic Reshuffling**: Deck reshuffles after any round containing a Joker
- **Round Management**: Deal cards, start round, navigate turns, end round workflow

### Combatant Management
- **Multiple Combatant Types**: PCs, NPCs, and Extras (groups)
- **Token Integration**: Add combatants directly from map tokens via context menu
- **Avatar Support**: Displays token images in the initiative order
- **Late Joiners**: Add combatants mid-round with automatic card dealing
- **Incapacitated State**: Mark combatants as inactive without removing them (incapacitated Extras get no card and are skipped; an Extra marked active mid-round waits for the next deal)

### Tactical Combat Features
- **Hold Actions**: Combatants can hold their action across rounds
- **Act Now**: Held combatants can interrupt to act before or after the current turn
- **Lose Turn**: Handle Shaken/Stunned status for held combatants
- **Card Replacement**: Draw additional cards and choose which to keep (for Edges like Quick/Level Headed)

### GM Controls
- **Privacy Mode**: Hide NPC cards from players until their turn
- **Manual Card Selection**: Click on any card to manage replacements
- **Full Authority**: GM can modify any combatant's state
- **Bulk Actions**: Remove all NPCs/Extras or perform full reset
- **End Initiative**: Reset the encounter while preserving combatant list

### Player Features
- **Read-Only View**: Players see the initiative order and their cards
- **Privacy Respect**: NPCs remain hidden when privacy mode is enabled
- **Clear Turn Indicators**: Active combatant is highlighted
- **Initiative Status**: Shows current round and deck status (players see no deck counts when privacy mode is on)

### Quality of Life
- **Undo System**: Local undo with checkpoints for all GM actions except Full Reset
- **Persistent State**: Initiative survives page refreshes via room metadata
- **Multi-Client Sync**: All connected clients see the same state
- **Theme Support**: Adapts to Owlbear Rodeo's light/dark themes
- **Responsive Design**: Works in both popover and modal views

## Usage

### Getting Started
1. **Open the extension** from the Owlbear Rodeo extensions panel
2. **Add combatants** using either:
   - The "Add Combatant" button in the header
   - Right-clicking tokens on the map and selecting "Add as PC/NPC/Extra"
3. **Deal cards** by clicking "Start Initiative" (later rounds: "Deal Cards"), make card adjustments, then click "Start Round"
4. **Navigate turns** using Previous/Next buttons during combat
5. **End round** when all combatants have acted, then deal the next round or click "End Initiative"

### GM Controls

#### Privacy Mode
Toggle the eye icon in the header to enable privacy mode. When active:
- NPCs are hidden from players by default
- NPCs are automatically revealed when their turn comes up
- Individual NPCs can be manually revealed/hidden

#### Managing Cards
- Click on any combatant's card to open the card chooser
- Draw additional cards for Quick/Level Headed edges
- Select which card to keep (GM decides based on table discussion)
- Undo last draw if needed

#### Hold Mechanics
- Active combatants can go on hold (hand icon)
- Held combatants keep their card for the rest of the round and aren't dealt a new one while they hold
- Held combatants can "Act Now" to interrupt (arrow icons)
- Shaken/Stunned combatants can "Lose Turn" (ban icon)

### Player View
Players have a read-only view showing:
- The current initiative order (respecting privacy settings)
- Their own cards and status
- The active combatant
- Round and deck information

## Technical Details

### Architecture
- **Frontend**: React 19 with TypeScript, Vite and Material-UI
- **State Management**: Redux Toolkit
- **Persistence**: Owlbear Rodeo **room metadata** (single source of truth), key `rodeo.owlbear.swade-initiative/state`. All scenes in a room share one encounter.
- **Background Page**: A hidden page registers the token context menus, so they work even when the tracker panel was never opened
- **Sync Strategy**: Only GMs write. Each change gets a new revision and the id of the window that made it, and stores the state it was made from. If two GMs change the tracker at the same time, a GM whose action the other write does not include replays it on top of that write, so both actions are kept and all clients converge. If a replay is not possible (for example a GM on an older version of the extension, or an Undo), the GM gets a warning that the change was discarded. Each write stores the extension version and a sync protocol number. When a state with a newer sync protocol (or state version) is in the room, an older window shows "A newer version of the initiative tracker is in use. Reload this page to update." and does not write; when a client from before the sync protocol writes, the GM is told once to ask the others to reload. Patch releases that keep the same protocol need no reload.
- **Size Guard**: Room metadata has 16 kB for all extensions together. The GM gets a warning above 10 kB. A change that does not fit is not saved, and the GM gets an error.
- **Undo System**: Per-tab undo history in sessionStorage (shared by the tab's popover, background page and modals; kept across a reload; a duplicated tab starts empty). Undo is available only while nobody else changed the tracker after your last action. If your action was replayed on another GM's change, Undo removes only your action.
- **Privacy**: Hidden NPCs are hidden in the user interface only. The full state is in room metadata, which every client can read.

Details: [docs/app-owlbear-integration.md](docs/app-owlbear-integration.md).

### Data Model
The extension keeps a single `EncounterState` (version 2) in room metadata:
- **Deck state**: Remaining cards, in-play cards, discard pile, reshuffle flag
- **Combatant list**: Rows in initiative order, with cards and status
- **Round tracking**: Current round number and phase
- **Turn state**: Active combatant
- **Settings**: Privacy mode
- **Revision and writer id**: Identify each saved state
- **Parent** (stored only): The saved state this one was made from, used to merge concurrent GM changes

Older (v1) states are migrated when they are read.

### Key Components
- `InitiativeTracker.tsx`: Main panel
- `background.ts` / `contextMenu.ts`: Background page and token context menus
- `HeaderBar.tsx`: Title, round info, sync status, and GM controls
- `ParticipantList.tsx` / `ParticipantRow.tsx`: Initiative order and per-combatant actions
- `ControlBar.tsx`: Deal, navigation, and round controls
- `CardChooserModal.tsx` / `AddParticipantModal.tsx`: Modals
- `store/swadeSlice.ts`: Redux actions and game logic
- `store/selectors.ts`: Derived state and privacy filtering
- `store/syncEngine.ts` / `store/stateCodec.ts`: Room sync and stored format
- `store/localUndoStore.ts`: Undo history

## Development

### Prerequisites
- Node.js (CI uses Node 26)
- Yarn package manager

### Setup
```bash
# Install dependencies
yarn

# Run development server
yarn dev

# Lint and type check
yarn lint

# Run tests
yarn test

# Build for production
yarn build

# Preview production build
yarn preview
```

### Project Structure
```
background.html       # Background page (context menus)
index.html            # Popover and modals
src/
├── components/       # React components
├── store/            # Redux store, sync engine, codec, migrations, undo
├── utils/            # Card ids, scoring, styles, shuffle
├── contexts/         # Undo React context
├── hooks/            # Custom React hooks
├── test/             # OBR mock and test setup
├── background.ts     # Background page entry
├── contextMenu.ts    # Token context menus
└── getPluginId.ts    # OBR plugin id helper
```

### Testing
`yarn test` runs unit and component tests with an OBR mock (multiple clients, failure injection, room size limit).

Manual testing in Owlbear Rodeo development rooms is still required for:
- Multi-client synchronization
- Token context menus (also with the panel never opened)
- Privacy mode with GM/player role switching
- Modals saving before they close
- The room metadata size limit

## License

GNU GPLv3

## Attribution

- **Original Initiative Tracker**: [Owlbear Rodeo](https://github.com/owlbear-rodeo/initiative-tracker)
- **Icon**: Spade symbol from [Phosphor Icons](https://phosphoricons.com/)
- **SWADE System**: [Pinnacle Entertainment Group](https://peginc.com/savage-settings/savage-worlds/)

## Contributing

This is a fork of the original Owlbear Rodeo initiative tracker, extensively modified for SWADE-specific functionality. Issues and pull requests are welcome.

### Copyright
- Copyright (C) 2023 Owlbear Rodeo (original initiative tracker)
- Copyright (C) 2024 ervwalter (SWADE modifications)