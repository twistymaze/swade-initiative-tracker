// Parse, encode and measure the encounter state stored in OBR room metadata.
//
// Stored form (v2) uses the same keys as EncounterState so that v1 clients can still
// read it: false booleans and non-https image URLs are omitted, arrays never are.
// One extra key, `parent`, is stored only: the identity of the room state the writer's
// state was derived from (the sync engine uses it to rebase concurrent changes). It is not
// part of EncounterState, so states compare equal in every iframe. It also names the state
// it belongs to (`of`): a writer that copies unknown keys (the released v1 app spreads the
// stored object and raises the revision) leaves a parent that is not its own, and that
// parent is ignored.
// A second stored-only key, `client`, names the app that wrote the state: its version
// (package.json) and the sync protocol of its engine. It is bound to the state's identity in
// the same way, so a copied `client` counts as missing (an older app wrote the state).

import type { CardId, EncounterState, ParticipantRow, ParticipantType, Phase, StateIdentity } from './types';
import { CURRENT_STATE_VERSION, migrateState, type RawState } from './migrations';
import { generateAllCardIds } from '../utils/cardIds';

/** The app that wrote a state (stored `client`). */
export interface ClientInfo {
  /** Sync engine protocol (SYNC_PROTOCOL), a positive integer that only rises. */
  syncProtocol: number;
  /** App version (package.json); omitted when unknown. */
  appVersion?: string;
}

export type ParseResult =
  | { kind: 'absent' }
  | { kind: 'ok'; state: EncounterState; parent: StateIdentity | null; client: ClientInfo | null }
  | { kind: 'invalid' }
  | { kind: 'too-new' };

const ALL_CARD_IDS: readonly CardId[] = generateAllCardIds();
const KNOWN_CARDS = new Set<string>(ALL_CARD_IDS);
const PHASES: readonly Phase[] = ['setup', 'between_rounds', 'cards_dealt', 'in_round'];
const TYPES: readonly ParticipantType[] = ['PC', 'NPC', 'GROUP'];

const isRecord = (value: unknown): value is RawState =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Only https URLs are kept (blocks javascript:, data:, http:). */
export function isSafeImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const isCardId = (value: unknown): value is CardId => typeof value === 'string' && KNOWN_CARDS.has(value);

function parseRow(raw: unknown): ParticipantRow | null {
  if (!isRecord(raw)) return null;
  const { id, name, type } = raw;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string') return null;
  if (!TYPES.includes(type as ParticipantType)) return null;
  const row: ParticipantRow = {
    id,
    name,
    type: type as ParticipantType,
    inactive: raw.inactive === true,
    onHold: raw.onHold === true,
    revealed: raw.revealed === true,
    candidateIds: Array.isArray(raw.candidateIds) ? raw.candidateIds.filter(isCardId) : [],
  };
  if (isSafeImageUrl(raw.imageUrl)) row.imageUrl = raw.imageUrl;
  if (isCardId(raw.currentCardId)) row.currentCardId = raw.currentCardId;
  if (raw.actNowTurn === true) row.actNowTurn = true; // optional; older clients ignore it
  return row;
}

/** Deck piles: known ids only, each card once; cards missing from all piles go to discard. */
function parseDeck(raw: unknown): EncounterState['deck'] | null {
  if (!isRecord(raw)) return null;
  const { remaining, inPlay, discard } = raw;
  if (!Array.isArray(remaining) || !Array.isArray(inPlay) || !Array.isArray(discard)) return null;
  const seen = new Set<string>();
  const clean = (pile: unknown[]) =>
    pile.filter((id): id is CardId => {
      if (!isCardId(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const deck: EncounterState['deck'] = {
    remaining: clean(remaining),
    inPlay: clean(inPlay),
    discard: clean(discard),
    reshuffleAfterRound: raw.reshuffleAfterRound === true,
  };
  if (isNonNegativeInt(raw.jokersDealtThisRound) && raw.jokersDealtThisRound > 0) {
    deck.jokersDealtThisRound = raw.jokersDealtThisRound;
  }
  deck.discard.push(...ALL_CARD_IDS.filter((id) => !seen.has(id)));
  return deck;
}

/**
 * Make row cards agree with the deck piles (in place): a row may hold only cards in
 * `inPlay`, each card on one row only (first row wins), each candidate once; in-play
 * cards that no row holds go to the discard pile. Keeps the 54-unique invariant and
 * `inPlay` = the cards on the rows, so a later deal cannot give a card to two rows.
 */
function reconcileRowCards(rows: ParticipantRow[], deck: EncounterState['deck']) {
  const inPlay = new Set(deck.inPlay);
  const held = new Set<CardId>();
  for (const row of rows) {
    const own = new Set<CardId>();
    const take = (id: CardId) => {
      if (own.has(id)) return true;
      if (!inPlay.has(id) || held.has(id)) return false;
      own.add(id);
      return true;
    };
    if (row.currentCardId !== undefined && !take(row.currentCardId)) delete row.currentCardId;
    const seen = new Set<CardId>();
    row.candidateIds = row.candidateIds.filter((id) => {
      if (seen.has(id) || !take(id)) return false;
      seen.add(id);
      return true;
    });
    for (const id of own) held.add(id);
  }
  const unheld = deck.inPlay.filter((id) => !held.has(id));
  if (unheld.length > 0) {
    deck.inPlay = deck.inPlay.filter((id) => held.has(id));
    deck.discard.push(...unheld);
  }
}

const identityKey = (id: StateIdentity) => `${id.revision}/${id.writerId}`;

/**
 * The stored `parent` identity, or null when it is missing or malformed (older writers), or
 * when it belongs to another state (copied by a writer that keeps unknown keys).
 */
function parseParent(raw: unknown, state: EncounterState): StateIdentity | null {
  if (!isRecord(raw) || !isNonNegativeInt(raw.revision) || typeof raw.writerId !== 'string') return null;
  if (raw.of !== identityKey(state)) return null;
  return { revision: raw.revision, writerId: raw.writerId };
}

const MAX_APP_VERSION_LENGTH = 32;

/**
 * The stored `client`, or null when it is missing or malformed (older writers), or when it
 * belongs to another state (copied by a writer that keeps unknown keys). A bad `appVersion`
 * alone is dropped.
 */
function parseClient(raw: unknown, state: EncounterState): ClientInfo | null {
  if (!isRecord(raw) || !isNonNegativeInt(raw.syncProtocol) || raw.syncProtocol < 1) return null;
  if (raw.of !== identityKey(state)) return null;
  const client: ClientInfo = { syncProtocol: raw.syncProtocol };
  const { appVersion } = raw;
  if (typeof appVersion === 'string' && appVersion !== '' && appVersion.length <= MAX_APP_VERSION_LENGTH) client.appVersion = appVersion;
  return client;
}

function parseCurrent(state: RawState): EncounterState | null {
  const { round, phase } = state;
  if (!isNonNegativeInt(round) || !PHASES.includes(phase as Phase)) return null;
  const deck = parseDeck(state.deck);
  if (!deck || !Array.isArray(state.rows)) return null;
  // The Joker count belongs to a dealt round. A v1 client keeps the field through End
  // Round, so outside a round it is stale: drop it.
  if (phase !== 'cards_dealt' && phase !== 'in_round') delete deck.jokersDealtThisRound;

  const rows: ParticipantRow[] = [];
  const rowIds = new Set<string>();
  for (const rawRow of state.rows) {
    const row = parseRow(rawRow);
    if (row && !rowIds.has(row.id)) {
      rowIds.add(row.id);
      rows.push(row);
    }
  }

  reconcileRowCards(rows, deck);

  const activeRowId = isRecord(state.turn) ? state.turn.activeRowId : null;
  const settings = isRecord(state.settings) ? state.settings : {};
  return {
    version: CURRENT_STATE_VERSION,
    round,
    phase: phase as Phase,
    deck,
    rows,
    turn: { activeRowId: typeof activeRowId === 'string' && rowIds.has(activeRowId) ? activeRowId : null },
    settings: { hideNpcFromPlayers: settings.hideNpcFromPlayers !== false },
    revision: isNonNegativeInt(state.revision) ? state.revision : 0,
    writerId: typeof state.writerId === 'string' ? state.writerId : '',
  };
}

/**
 * The only way stored data becomes an EncounterState. Never throws: bad rows and card
 * ids are dropped, missing optional fields get defaults, a broken shape is `invalid`.
 */
export function parseEncounterState(raw: unknown): ParseResult {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (!isRecord(raw)) return { kind: 'invalid' };
  try {
    const migrated = migrateState(raw);
    if (migrated.kind !== 'ok') return migrated;
    const state = parseCurrent(migrated.state);
    if (!state) return { kind: 'invalid' };
    return { kind: 'ok', state, parent: parseParent(migrated.state.parent, state), client: parseClient(migrated.state.client, state) };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Compact stored form. Same keys as EncounterState; omits false booleans, keeps all arrays.
 * `parent` and `client` (sync engine only) are added when given, bound to this state's
 * identity (`of`).
 */
export function encodeEncounterState(state: EncounterState, parent?: StateIdentity | null, client?: ClientInfo | null): RawState {
  const deck: RawState = {
    remaining: state.deck.remaining,
    inPlay: state.deck.inPlay,
    discard: state.deck.discard,
  };
  if (state.deck.reshuffleAfterRound) deck.reshuffleAfterRound = true;
  // Optional (older clients ignore it); omitted when 0.
  if (state.deck.jokersDealtThisRound) deck.jokersDealtThisRound = state.deck.jokersDealtThisRound;

  const rows = state.rows.map((row) => {
    const out: RawState = { id: row.id, name: row.name };
    if (isSafeImageUrl(row.imageUrl)) out.imageUrl = row.imageUrl;
    out.type = row.type;
    if (row.inactive) out.inactive = true;
    if (row.onHold) out.onHold = true;
    if (row.revealed) out.revealed = true;
    if (row.currentCardId !== undefined) out.currentCardId = row.currentCardId;
    if (row.actNowTurn) out.actNowTurn = true;
    out.candidateIds = row.candidateIds;
    return out;
  });

  const encoded: RawState = {
    version: state.version,
    round: state.round,
    phase: state.phase,
    deck,
    rows,
    turn: { activeRowId: state.turn.activeRowId },
    settings: { hideNpcFromPlayers: state.settings.hideNpcFromPlayers },
    revision: state.revision,
    writerId: state.writerId,
  };
  if (parent) encoded.parent = { revision: parent.revision, writerId: parent.writerId, of: identityKey(state) };
  if (client) {
    const out: RawState = { syncProtocol: client.syncProtocol };
    if (client.appVersion) out.appVersion = client.appVersion;
    out.of = identityKey(state);
    encoded.client = out;
  }
  return encoded;
}

const encoder = new TextEncoder();

/** UTF-8 byte length of a value's JSON form (0 for undefined). */
export function measureJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : encoder.encode(json).length;
}

/** Bytes the state takes in room metadata (key included). */
export function measureEncounterState(key: string, state: EncounterState): number {
  return measureJsonBytes({ [key]: encodeEncounterState(state) });
}
