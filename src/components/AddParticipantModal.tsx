import { useState, type FormEvent } from "react";
import { Alert, Box, Typography, TextField, Button, Stack } from "@mui/material";
import OBR from "@owlbear-rodeo/sdk";

import { getPluginId } from "../getPluginId";
import type { ParticipantType } from "../store/types";
import { useAppDispatch } from "../store/hooks";
import { createParticipant, removeParticipant } from "../store/swadeSlice";
import { useUndo } from "../hooks/useUndo";
import { saveAndSettle, saveChanges } from "../utils/saveChanges";
import { sendToBackground } from "../actionChannel";

const MODAL_ID = getPluginId("add-participant");

const TYPE_BUTTONS: [ParticipantType, string][] = [
  ["PC", "+PC"],
  ["NPC", "+NPC"],
  ["GROUP", "+Extra"],
];

/** Type used when the name field is submitted with Enter. */
const DEFAULT_TYPE: ParticipantType = "NPC";

/** Where an unsaved add lives after a failed save: the background page, or this modal. */
type Pending = { where: "background" | "local"; rowId: string };

/**
 * Rendered in its own modal iframe (`/?view=add-participant`). The add is dispatched by
 * the background page (actionChannel.ts), whose engine outlives this iframe; when no
 * background answers, the modal dispatches it itself and saves with a settle delay.
 */
export function AddParticipantModal() {
  const dispatch = useAppDispatch();
  const { captureCheckpoint, discardOwnCheckpoint } = useUndo();
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The combatant was added, but the write failed: retry saves it (no second add).
  const [pending, setPending] = useState<Pending | null>(null);
  const saveFailed = pending !== null;
  const trimmedName = name.trim();

  const close = () => OBR.modal.close(MODAL_ID).catch((error) => console.error("[SWADE] Failed to close modal", error));

  /** Closing the modal destroys this iframe: close only once the change is saved. */
  const finish = async (saved: boolean, next: Pending) => {
    if (saved) await close();
    setPending(saved ? null : next);
    setIsSubmitting(false);
  };

  const retry = async () => {
    if (!pending) return;
    setIsSubmitting(true);
    const saved =
      pending.where === "local"
        ? await saveAndSettle("the new combatant")
        : (await sendToBackground({ op: "dispatch", description: "", actions: [] })) === "saved";
    await finish(saved, pending);
  };

  /**
   * After a failed save, take the add and its checkpoint back, and save that: an earlier
   * write may have put the row in the room. Close only once that is saved.
   */
  const cancelUnsaved = async () => {
    if (!pending) return;
    setIsSubmitting(true);
    let saved: boolean;
    if (pending.where === "local") {
      discardOwnCheckpoint();
      dispatch(removeParticipant(pending.rowId));
      saved = await saveChanges("the cancelled combatant");
    } else {
      saved = (await sendToBackground({ op: "cancel-add", rowId: pending.rowId })) === "saved";
    }
    if (saved) await close();
    else setIsSubmitting(false);
  };

  const handleAddParticipant = async (type: ParticipantType) => {
    if (!trimmedName || isSubmitting || saveFailed) return;
    setIsSubmitting(true);
    const description = `Add Combatant: ${trimmedName}`;
    const action = createParticipant({ name: trimmedName, type });
    const outcome = await sendToBackground({ op: "dispatch", description, actions: [action] });
    if (outcome !== "unavailable") return finish(outcome === "saved", { where: "background", rowId: action.payload.id });
    // Fallback. Checkpoint and dispatch in the same task (the undo store requires it).
    captureCheckpoint(description);
    dispatch(action);
    await finish(await saveAndSettle("the new combatant"), { where: "local", rowId: action.payload.id });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void handleAddParticipant(DEFAULT_TYPE);
  };

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", p: 2 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 2 }}>
        Add Combatant
      </Typography>

      <Stack component="form" onSubmit={handleSubmit} noValidate spacing={2} sx={{ flex: 1, justifyContent: "center" }}>
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          fullWidth
          autoFocus
          disabled={isSubmitting || saveFailed}
          variant="outlined"
          size="small"
        />

        {saveFailed ? (
          <>
            <Alert severity="error" sx={{ py: 0 }}>
              Could not save — try again
            </Alert>
            <Stack direction="row" spacing={1}>
              <Button onClick={() => void retry()} disabled={isSubmitting} size="small" variant="contained" sx={{ flex: 1 }}>
                {isSubmitting ? "Saving..." : "Try again"}
              </Button>
              <Button onClick={() => void cancelUnsaved()} disabled={isSubmitting} size="small" color="inherit" sx={{ flex: 1 }}>
                Cancel
              </Button>
            </Stack>
          </>
        ) : (
          <>
            <Stack direction="row" spacing={1}>
              {TYPE_BUTTONS.map(([type, label]) => (
                <Button
                  key={type}
                  onClick={() => void handleAddParticipant(type)}
                  disabled={!trimmedName || isSubmitting}
                  size="small"
                  variant="contained"
                  sx={{ flex: 1 }}
                >
                  {isSubmitting ? "Adding..." : label}
                </Button>
              ))}
            </Stack>
            <Button onClick={() => void close()} disabled={isSubmitting} size="small" color="inherit" fullWidth>
              Cancel
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );
}
