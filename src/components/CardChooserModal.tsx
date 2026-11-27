import { useState, type ReactElement } from "react";
import { Alert, Box, Typography, Button, Stack, IconButton, Tooltip } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import UndoIcon from "@mui/icons-material/Undo";
import type { UnknownAction } from "@reduxjs/toolkit";
import OBR from "@owlbear-rodeo/sdk";

import { getPluginId } from "../getPluginId";
import { addCandidateCard, canAddCandidateCard, discardExtraCandidates, selectKeeperCard, undoLastDraw } from "../store/swadeSlice";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { useUndo } from "../hooks/useUndo";
import { saveAndSettle, saveChanges } from "../utils/saveChanges";
import { sendToBackground } from "../actionChannel";
import { ActionCard } from "./ActionCard";

const MODAL_ID = getPluginId("card-chooser");

/**
 * Tooltip for the draw controls: shown above (never over Cancel and Choose below),
 * never takes pointer events, and closes on click.
 */
function ChooserTip({ title, children }: { title: string; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip title={title} placement="top" disableInteractive open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}>
      <span onClickCapture={() => setOpen(false)}>{children}</span>
    </Tooltip>
  );
}

/** Rendered in its own modal iframe (`/?view=card-chooser&participantId=…`). */
export function CardChooserModal() {
  const dispatch = useAppDispatch();
  const { captureCheckpoint } = useUndo();
  const [selectedCardId, setSelectedCardId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const participantId = new URLSearchParams(window.location.search).get("participantId");
  const participant = useAppSelector((state) => state.swade.rows.find((p) => p.id === participantId));
  // Same rule as the reducer: off between rounds (e.g. another GM ended the round) and with no card left.
  // An empty deck is reshuffled from the discard pile on draw.
  const canDraw = useAppSelector((state) => canAddCandidateCard(state.swade, participantId));
  const cardsDealt = useAppSelector((state) => state.swade.phase === "cards_dealt" || state.swade.phase === "in_round");

  const close = () => OBR.modal.close(MODAL_ID).catch((error) => console.error("[SWADE] Failed to close modal", error));

  // The row was removed while the chooser was open (another GM, or an undo).
  if (!participant) {
    return (
      <Stack spacing={2} sx={{ height: "100vh", alignItems: "center", justifyContent: "center", px: 2 }}>
        <Typography variant="body2" color="text.secondary">
          This combatant no longer exists.
        </Typography>
        <Button onClick={() => void close()} variant="outlined" size="small">
          Close
        </Button>
      </Stack>
    );
  }

  const { candidateIds, currentCardId } = participant;
  // Derived, so the selection is never a card that is no longer a candidate (e.g. after Undo Last Draw).
  const effectiveSelectedCardId = candidateIds.includes(selectedCardId) ? selectedCardId : currentCardId ?? "";
  const additionalCardIds = candidateIds.filter((id) => id !== currentCardId);

  /**
   * Have the background page dispatch and save the change (actionChannel.ts): its engine
   * outlives this iframe. When no background answers, dispatch here instead; before a close,
   * save with a settle delay (closing destroys this iframe).
   */
  const act = async (description: string, action: UnknownAction, closeAfter = false) => {
    setIsSubmitting(true);
    const label = `${description}: ${participant.name}`;
    const outcome = await sendToBackground({ op: "dispatch", description: label, actions: [action] });
    let saved = outcome === "saved";
    if (outcome === "unavailable") {
      // Checkpoint and dispatch in the same task (the undo store requires it).
      captureCheckpoint(label);
      dispatch(action);
      // A draw is written now too: a backdrop close would destroy this iframe before the debounce.
      saved = closeAfter ? await saveAndSettle("the card choice") : await saveChanges("the draw");
    }
    if (saved && closeAfter) await close();
    setSaveFailed(!saved);
    setIsSubmitting(false);
  };

  // A retry after a failed save sends the action again: it changes nothing the second time.
  const handleConfirm = () => {
    if (!effectiveSelectedCardId) return;
    void act("Choose Card", selectKeeperCard({ participantId: participant.id, cardId: effectiveSelectedCardId }), true);
  };

  const handleCancel = () => {
    // Extra cards drawn in this session go to the discard pile.
    void act("Discard Extra Cards", discardExtraCandidates(participant.id), true);
  };

  const renderCard = (cardId: string) => (
    <ActionCard
      key={cardId}
      cardId={cardId}
      onClick={() => setSelectedCardId(cardId)}
      selected={cardId === effectiveSelectedCardId}
      sx={{ border: "none" }}
    />
  );

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, textAlign: "center", pt: 2, px: 2 }}>
        Choose Initiative Card - {participant.name}
      </Typography>

      {/* Scrolls when many draws wrap onto several lines, so no control is cut off. */}
      <Box data-testid="chooser-body" sx={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", pb: 2 }}>
        <Stack spacing={3} sx={{ px: 2, my: "auto" }}>
          <Stack direction="row" spacing={4} useFlexGap sx={{ justifyContent: "center", flexWrap: "wrap" }}>
            {currentCardId && (
              <Stack spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="caption" sx={{ fontWeight: 500, textAlign: "center" }}>
                  Original
                </Typography>
                <Stack direction="row" spacing={1}>
                  {renderCard(currentCardId)}
                </Stack>
              </Stack>
            )}

            <Stack spacing={1} sx={{ alignItems: "center", minWidth: 0 }}>
              <Typography variant="caption" sx={{ fontWeight: 500, textAlign: "center" }}>
                Additional
              </Typography>
              <Stack
                data-testid="candidate-cards"
                direction="row"
                spacing={1}
                useFlexGap
                sx={{ alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}
              >
                {additionalCardIds.map(renderCard)}
                <ChooserTip title="Draw Additional Card">
                  <IconButton
                      aria-label="Draw additional card"
                      onClick={() => void act("Draw Card", addCandidateCard(participant.id))}
                      disabled={!canDraw || isSubmitting}
                      size="small"
                    >
                      <AddIcon fontSize="small" />
                  </IconButton>
                </ChooserTip>
                {candidateIds.length > 1 && (
                  <ChooserTip title="Undo Last Draw">
                    <IconButton
                        aria-label="Undo last draw"
                        onClick={() => void act("Undo Draw", undoLastDraw(participant.id))}
                        disabled={isSubmitting}
                        size="small"
                      >
                        <UndoIcon fontSize="small" />
                    </IconButton>
                  </ChooserTip>
                )}
              </Stack>
            </Stack>

            {candidateIds.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center", py: 4 }}>
                {cardsDealt ? "No cards drawn for this combatant yet" : "The round has ended. Cards can be drawn after the next deal."}
              </Typography>
            )}
          </Stack>

          {saveFailed && (
            <Alert severity="error" sx={{ py: 0 }}>
              Could not save — try again
            </Alert>
          )}

          <Stack direction="row" spacing={2} sx={{ justifyContent: "center" }}>
            <Button
              onClick={handleConfirm}
              disabled={!effectiveSelectedCardId || isSubmitting || candidateIds.length === 0}
              variant="contained"
              size="small"
            >
              {isSubmitting ? "Saving..." : "Choose Selected Card"}
            </Button>
            <Button onClick={handleCancel} disabled={isSubmitting} variant="outlined" size="small">
              Cancel
            </Button>
          </Stack>
        </Stack>
      </Box>
    </Box>
  );
}
