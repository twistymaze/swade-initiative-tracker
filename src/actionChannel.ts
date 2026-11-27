// Modal → background action channel.
//
// A modal iframe is destroyed when it closes, and with it its sync engine and action log.
// If another GM's write that misses the modal's change lands after that, no engine can
// replay the change, and it is lost. So a modal does not dispatch its changes itself: it
// sends the Redux actions to the background page of the same OBR connection, which lives
// as long as the room is open. The background dispatches them (its engine logs and replays
// them like any own action), saves, and replies. The modal closes after the reply.
//
// Transport: a same-origin `BroadcastChannel`, not `OBR.broadcast` with destination LOCAL.
// - Whether LOCAL reaches the background page is decided by the host; the SDK only
//   forwards the message (api/BroadcastApi.js), so it cannot be confirmed from the source.
// - LOCAL broadcasts count against OBR's network rate limit (community reports); the
//   room writes need that budget.
// - The SDK's broadcast unsubscribe message carries no listener id, so two subscriptions
//   in one iframe can cancel each other (as with player.onChange).
// All iframes of the extension share one origin, so a BroadcastChannel reaches them. It
// also reaches other tabs of the same browser (a second tab of the same GM), so every
// message carries the OBR connection id, which is the same for all iframes of one tab:
// a background page handles only requests from its own connection.
//
// Any same-origin page can post on the channel: messages are validated, and only the
// known modal actions are accepted, rebuilt from checked fields.
import type { UnknownAction } from "@reduxjs/toolkit";
import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "./getPluginId";
import {
  addCandidateCard,
  createParticipant,
  discardExtraCandidates,
  removeParticipant,
  selectKeeperCard,
  undoLastDraw,
} from "./store/swadeSlice";
import type { ParticipantType } from "./store/types";

export const ACTION_CHANNEL = getPluginId("modal-actions");
/** The modal falls back to a local dispatch when no background accepted within this time. */
export const ACCEPT_TIMEOUT_MS = 2000;
/**
 * A background page dispatches only requests younger than this, so it never dispatches a
 * request whose modal may already have fallen back (the margin covers the reply's delivery).
 */
export const ACCEPT_WINDOW_MS = 1000;
/** After acceptance, the save may take a while (write retries with backoff, SDK timeouts). */
export const RESULT_TIMEOUT_MS = 30_000;

// ---------- messages ----------

export type ModalOp =
  /** Capture one undo checkpoint, dispatch the actions, save. No actions: only save (retry). */
  | { op: "dispatch"; description: string; actions: UnknownAction[] }
  /** Take back an added row whose save failed: drop its checkpoint, remove the row, save. */
  | { op: "cancel-add"; rowId: string };

interface RequestMessage {
  kind: "request";
  id: string;
  connectionId: string;
  sentAt: number;
  op: ModalOp;
}

interface ReplyMessage {
  kind: "accepted" | "rejected" | "result";
  id: string;
  connectionId: string;
  ok?: boolean;
}

/** saved: in the room. failed: the background has it but could not save. unavailable: nothing done. */
export type Outcome = "saved" | "failed" | "unavailable";

const MAX_ACTIONS = 10;
const MAX_TEXT = 200;
const PARTICIPANT_TYPES: readonly ParticipantType[] = ["PC", "NPC", "GROUP"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, min = 1): value is string =>
  typeof value === "string" && value.length >= min && value.length <= MAX_TEXT;

/** Rebuild one allowed action from checked fields, or null. */
export function parseModalAction(raw: unknown): UnknownAction | null {
  if (!isRecord(raw)) return null;
  const { type, payload } = raw;
  if (type === createParticipant.type) {
    if (!isRecord(payload) || !isText(payload.id) || !isText(payload.name)) return null;
    if (!PARTICIPANT_TYPES.includes(payload.type as ParticipantType)) return null;
    if (payload.imageUrl !== undefined && typeof payload.imageUrl !== "string") return null;
    const row = { id: payload.id, name: payload.name, type: payload.type as ParticipantType };
    return { type, payload: payload.imageUrl === undefined ? row : { ...row, imageUrl: payload.imageUrl } };
  }
  if (type === selectKeeperCard.type) {
    if (!isRecord(payload) || !isText(payload.participantId) || !isText(payload.cardId)) return null;
    return selectKeeperCard({ participantId: payload.participantId, cardId: payload.cardId });
  }
  for (const creator of [addCandidateCard, discardExtraCandidates, undoLastDraw]) {
    if (type === creator.type) return isText(payload) ? creator(payload) : null;
  }
  return null;
}

function parseOp(raw: unknown): ModalOp | null {
  if (!isRecord(raw)) return null;
  if (raw.op === "cancel-add") return isText(raw.rowId) ? { op: "cancel-add", rowId: raw.rowId } : null;
  if (raw.op !== "dispatch" || !isText(raw.description, 0) || !Array.isArray(raw.actions)) return null;
  if (raw.actions.length > MAX_ACTIONS) return null;
  const actions = raw.actions.map(parseModalAction);
  if (actions.some((a) => a === null)) return null;
  return { op: "dispatch", description: raw.description, actions: actions as UnknownAction[] };
}

function parseRequest(raw: unknown): RequestMessage | null {
  if (!isRecord(raw) || raw.kind !== "request" || !isText(raw.id) || !isText(raw.connectionId)) return null;
  if (typeof raw.sentAt !== "number" || !Number.isFinite(raw.sentAt)) return null;
  const op = parseOp(raw.op);
  return op && { kind: "request", id: raw.id, connectionId: raw.connectionId, sentAt: raw.sentAt, op };
}

function parseReply(raw: unknown): ReplyMessage | null {
  if (!isRecord(raw) || !isText(raw.id) || !isText(raw.connectionId)) return null;
  if (raw.kind !== "accepted" && raw.kind !== "rejected" && raw.kind !== "result") return null;
  return { kind: raw.kind, id: raw.id, connectionId: raw.connectionId, ok: raw.ok === true };
}

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(ACTION_CHANNEL);
  } catch {
    return null;
  }
}

// ---------- background side ----------

export interface ActionHandlerDeps {
  /** This iframe's OBR connection id. */
  getConnectionId: () => Promise<string>;
  /** Resolves when this iframe may act (sync started); false when it cannot (not GM, not loaded). */
  whenReady: () => Promise<boolean>;
  dispatch: (action: UnknownAction) => void;
  undo: () => { captureCheckpoint(description: string): void; discardOwnTopCheckpoint(addedRowId?: string): boolean } | null;
  /** Write now, also after a failed write; true when saved. */
  save: () => Promise<boolean>;
  now?: () => number;
}

/** Handle modal requests of this connection on the channel. Returns a stop function. */
export function startActionHandler(deps: ActionHandlerDeps): () => void {
  const channel = openChannel();
  if (!channel) return () => {};
  const now = deps.now ?? Date.now;
  const connection = deps.getConnectionId().catch((error) => {
    console.error("[SWADE] Failed to read the connection id; modal requests are not handled", error);
    return null;
  });
  let stopped = false;

  const reply = (request: RequestMessage, kind: ReplyMessage["kind"], ok?: boolean) => {
    if (stopped) return;
    const message: ReplyMessage = { kind, id: request.id, connectionId: request.connectionId, ok };
    channel.postMessage(message);
  };

  const handle = async (request: RequestMessage) => {
    if ((await connection) !== request.connectionId) return; // another tab or a stray message
    if (!(await deps.whenReady())) return reply(request, "rejected");
    // Checked right before the dispatch: an older request's modal may have fallen back already.
    if (now() - request.sentAt > ACCEPT_WINDOW_MS) return reply(request, "rejected");

    const { op } = request;
    const undo = deps.undo();
    if (op.op === "dispatch") {
      // Same task as the dispatches: the shared undo stack gets one checkpoint (none if no change).
      if (op.actions.length > 0) undo?.captureCheckpoint(op.description);
      for (const action of op.actions) deps.dispatch(action);
    } else {
      undo?.discardOwnTopCheckpoint(op.rowId); // only the add's own checkpoint
      deps.dispatch(removeParticipant(op.rowId));
    }
    reply(request, "accepted");
    let ok = false;
    try {
      ok = await deps.save();
    } catch (error) {
      console.error("[SWADE] Failed to save a modal change", error);
    }
    reply(request, "result", ok);
  };

  channel.onmessage = (event: MessageEvent) => {
    const request = parseRequest(event.data);
    if (request) void handle(request);
  };
  return () => {
    stopped = true;
    channel.close();
  };
}

// ---------- modal side ----------

const randomId = () => Math.random().toString(36).slice(2, 12);

/**
 * Send a change to this connection's background page and wait until it is saved.
 * "unavailable" means no background took it (none loaded, not ready, or no channel):
 * nothing was dispatched, and the caller dispatches locally instead.
 */
export async function sendToBackground(op: ModalOp): Promise<Outcome> {
  let connectionId: string;
  try {
    connectionId = await OBR.player.getConnectionId();
  } catch {
    return "unavailable";
  }
  const channel = openChannel();
  if (!channel) return "unavailable";

  const request: RequestMessage = { kind: "request", id: randomId(), connectionId, sentAt: Date.now(), op };
  return new Promise<Outcome>((resolve) => {
    let timer = setTimeout(() => finish("unavailable"), ACCEPT_TIMEOUT_MS);
    function finish(outcome: Outcome) {
      clearTimeout(timer);
      channel!.close();
      resolve(outcome);
    }
    channel.onmessage = (event: MessageEvent) => {
      const message = parseReply(event.data);
      if (!message || message.id !== request.id || message.connectionId !== connectionId) return;
      if (message.kind === "rejected") finish("unavailable");
      else if (message.kind === "result") finish(message.ok ? "saved" : "failed");
      else {
        clearTimeout(timer);
        timer = setTimeout(() => finish("failed"), RESULT_TIMEOUT_MS);
      }
    };
    channel.postMessage(request);
  });
}
