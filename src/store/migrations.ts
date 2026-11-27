// SWADE Initiative Tracker - stored state migrations.
// Migrations are pure: each takes the state at version v-1 and returns it at version v.

export const CURRENT_STATE_VERSION = 2;

export type RawState = Record<string, unknown>;
export type Migration = (state: RawState) => RawState;

export type MigrationResult =
  | { kind: 'ok'; state: RawState }
  | { kind: 'too-new' }
  | { kind: 'invalid' };

const isRecord = (value: unknown): value is RawState =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** v1 -> v2: drop the unused `tokenIds` and `drewThisRound` row fields; add `writerId`. */
function migrateV1ToV2(state: RawState): RawState {
  const rows = Array.isArray(state.rows)
    ? state.rows.map((row) => {
        if (!isRecord(row)) return row;
        const { tokenIds: _tokenIds, drewThisRound: _drew, ...rest } = row;
        return rest;
      })
    : state.rows;
  return { ...state, rows, writerId: '' };
}

/** Migration that produces version N is stored under key N. */
export const MIGRATIONS: Record<number, Migration> = {
  2: migrateV1ToV2,
};

/**
 * Bring stored state of any known version to `target`. A missing version means v1
 * (legacy). A version above `target` is `too-new`: the caller must not adopt or write it.
 * The input is never mutated.
 */
export function migrateState(
  raw: RawState,
  migrations: Record<number, Migration> = MIGRATIONS,
  target: number = CURRENT_STATE_VERSION
): MigrationResult {
  const version = raw.version === undefined ? 1 : raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'invalid' };
  }
  if (version > target) return { kind: 'too-new' };

  let state: RawState = structuredClone(raw);
  for (let v = version + 1; v <= target; v++) {
    const migration = migrations[v];
    if (!migration) return { kind: 'invalid' };
    state = migration(state);
  }
  return { kind: 'ok', state: { ...state, version: target } };
}
