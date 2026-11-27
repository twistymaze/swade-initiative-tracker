import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ListItem, Box, Typography, IconButton, Menu, MenuItem, ListItemIcon, Divider, TextField, Tooltip } from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import CheckIcon from "@mui/icons-material/Check";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import FavoriteIcon from "@mui/icons-material/Favorite";
import HeartBrokenIcon from "@mui/icons-material/HeartBroken";
import PanToolIcon from "@mui/icons-material/PanTool";
import BlockIcon from "@mui/icons-material/Block";
import EastIcon from "@mui/icons-material/East";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import OBR from "@owlbear-rodeo/sdk";

import type { ParticipantRow as ParticipantRowType, ParticipantType } from "../store/types";
import { useAppSelector, useAppDispatch } from "../store/hooks";
import { selectActiveParticipant, selectHasActed, selectPhase, selectPrivacyMode } from "../store/selectors";
import {
  removeParticipant,
  setHold,
  loseHold,
  insertActNow,
  setInactive,
  setRevealed,
  setParticipantType,
  renameParticipant,
  isIncapacitatedExtra,
} from "../store/swadeSlice";
import { getCardName, isJokerId } from "../utils/cardIds";
import { getPluginId } from "../getPluginId";
import { useUndo } from "../hooks/useUndo";
import { ParticipantAvatar } from "./ParticipantAvatar";
import { ActionCard } from "./ActionCard";
import { RowAction } from "./RowAction";

const TYPE_OPTIONS: [ParticipantType, string][] = [
  ["PC", "PC"],
  ["NPC", "NPC"],
  ["GROUP", "Extra"],
];

interface ParticipantRowProps {
  participant: ParticipantRowType;
  role?: "GM" | "PLAYER";
  editingId: string | null;
  setEditingId: (id: string | null) => void;
}

export const ParticipantRow = ({ participant, role, editingId, setEditingId }: ParticipantRowProps) => {
  const dispatch = useAppDispatch();
  const activeParticipant = useAppSelector(selectActiveParticipant);
  const phase = useAppSelector(selectPhase);
  const privacyEnabled = useAppSelector(selectPrivacyMode);
  const hasActed = useAppSelector((state) => selectHasActed(state, participant.id));
  const ref = useRef<HTMLLIElement>(null);
  const cancelEditRef = useRef(false);
  /** Set when the edit ends from the keyboard, so focus goes back to the name button. */
  const restoreFocusRef = useRef(false);
  const nameLabelRef = useRef<HTMLElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [editedName, setEditedName] = useState(participant.name);
  const { captureCheckpoint } = useUndo();

  const isGm = role === "GM";
  const isActive = activeParticipant?.id === participant.id;
  const isEditing = editingId === participant.id;

  // The edit UI unmounts when editing ends; put keyboard focus back on the name button.
  useEffect(() => {
    if (!isEditing && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      nameLabelRef.current?.focus();
    }
  }, [isEditing]);
  const inRound = phase === "in_round";
  // An incapacitated Extra cannot act: no Hold, Act Now or Lose Turn (its hold stays for when it is revived).
  const canAct = !isIncapacitatedExtra(participant);
  // A Joker may interrupt (Act Now / Hold) any time this round until it has acted.
  const isUnactedJoker = canAct && isJokerId(participant.currentCardId) && !hasActed;

  // Auto-scroll when this participant becomes active
  useEffect(() => {
    if (isActive) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [isActive]);

  /** Capture an undo checkpoint and dispatch in the same task (the undo store requires it). */
  const act = (description: string, action: Parameters<typeof dispatch>[0]) => {
    captureCheckpoint(description);
    dispatch(action);
  };

  const handleMenuClose = () => setMenuAnchor(null);

  const handleRemove = () => {
    handleMenuClose();
    act(`Remove: ${participant.name}`, removeParticipant(participant.id));
  };

  const handleChangeType = (type: ParticipantType) => {
    handleMenuClose();
    act(`Change ${participant.name} to ${type}`, setParticipantType({ id: participant.id, type }));
  };

  const handleCardClick = () => {
    // The modal captures its own undo checkpoints.
    OBR.modal
      .open({
        id: getPluginId("card-chooser"),
        url: `/?view=card-chooser&participantId=${encodeURIComponent(participant.id)}`,
        width: 500,
        height: 250,
        hideBackdrop: false,
      })
      .catch((error) => console.error("[SWADE] Failed to open the card chooser", error));
  };

  const startEditing = () => {
    if (!isGm) return;
    cancelEditRef.current = false;
    setEditedName(participant.name);
    setEditingId(participant.id);
  };

  /** Blur is the only save path (Enter blurs; Escape cancels, then blurs). */
  const handleNameBlur = (event: FocusEvent<HTMLElement>) => {
    // Tab to "Save name": that button unmounts with the edit UI, so keep focus on the row.
    if (event.relatedTarget && event.relatedTarget === saveButtonRef.current) restoreFocusRef.current = true;
    const trimmedName = editedName.trim();
    if (!cancelEditRef.current && trimmedName && trimmedName !== participant.name) {
      act(`Rename: ${participant.name} → ${trimmedName}`, renameParticipant({ id: participant.id, name: trimmedName }));
    }
    cancelEditRef.current = false;
    setEditingId(null);
  };

  const handleNameKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      cancelEditRef.current = event.key === "Escape";
      restoreFocusRef.current = true;
      // The handler sits on the input wrapper; blur the input itself.
      (event.target as HTMLElement).blur();
    }
  };

  const handleNameLabelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      startEditing();
    }
  };

  const showHold = inRound && canAct && (isActive || isUnactedJoker);
  const showLoseTurn = inRound && canAct && participant.onHold && !isActive;
  const showActNow = inRound && canAct && !isActive && (participant.onHold || isUnactedJoker);
  const currentCardId = participant.currentCardId;

  return (
    <ListItem
      ref={ref}
      sx={{
        bgcolor: isActive ? "action.selected" : "transparent",
        borderLeft: 3,
        borderColor: isActive ? "primary.main" : "transparent",
        borderLeftStyle: "solid",
        py: 1,
        position: "relative",
        "&:hover .row-options-button": { opacity: 1 },
      }}
    >
      {/* Options button, card / hold marker: span both rows on the right */}
      <Box
        sx={{
          position: "absolute",
          top: "50%",
          right: 16,
          transform: "translateY(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 1,
          justifyContent: "flex-end",
          zIndex: 1,
        }}
      >
        {isGm && (
          <>
            <Tooltip disableInteractive title="Options">
              <IconButton
                className="row-options-button"
                aria-label={`Options for ${participant.name}`}
                aria-haspopup="menu"
                onClick={(event: MouseEvent<HTMLElement>) => setMenuAnchor(event.currentTarget)}
                size="small"
                sx={{
                  opacity: menuAnchor ? 1 : 0,
                  transition: "opacity 0.2s",
                  color: "text.secondary",
                  "&:hover": { color: "primary.main" },
                  "&:focus-visible": { opacity: 1 },
                  "@media (hover: none)": { opacity: 1 },
                }}
              >
                <MoreVertIcon sx={{ fontSize: "1.25rem" }} />
              </IconButton>
            </Tooltip>

            <Menu
              anchorEl={menuAnchor}
              open={Boolean(menuAnchor)}
              onClose={handleMenuClose}
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
              transformOrigin={{ vertical: "top", horizontal: "left" }}
            >
              {TYPE_OPTIONS.map(([type, label]) => (
                <MenuItem key={type} onClick={() => handleChangeType(type)} dense selected={participant.type === type}>
                  <ListItemIcon>{participant.type === type ? <CheckIcon /> : null}</ListItemIcon>
                  {label}
                </MenuItem>
              ))}
              <Divider />
              <MenuItem onClick={handleRemove} dense>
                <ListItemIcon>
                  <DeleteIcon />
                </ListItemIcon>
                Remove
              </MenuItem>
            </Menu>
          </>
        )}

        {participant.onHold ? (
          <Box
            role="img"
            aria-label="On hold"
            sx={{ width: "50px", minWidth: "50px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <PanToolIcon sx={{ fontSize: "1.2rem", color: "text.primary" }} />
          </Box>
        ) : currentCardId ? (
          <ActionCard
            cardId={currentCardId}
            onClick={isGm ? handleCardClick : undefined}
            ariaLabel={isGm ? `${getCardName(currentCardId)} — manage cards for ${participant.name}` : undefined}
          />
        ) : null}
      </Box>

      <Box sx={{ mr: 1.5, display: "flex", alignItems: "center" }}>
        {/* Keyed by URL so a failed image does not stick after the URL changes. */}
        <ParticipantAvatar key={participant.imageUrl ?? ""} imageUrl={participant.imageUrl} name={participant.name} type={participant.type} />
      </Box>

      {/* Main content: leave space on the right for the card and options button */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          pr: participant.onHold || currentCardId ? 10 : isGm ? 4 : 2,
        }}
      >
        <Box sx={{ mb: 0.5, display: "flex", alignItems: "center", minHeight: "28px" }}>
          {isEditing ? (
            <>
              <TextField
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onKeyDown={handleNameKeyDown}
                onBlur={handleNameBlur}
                onFocus={(e) => e.target.select()}
                autoFocus
                variant="standard"
                size="small"
                slotProps={{ htmlInput: { "aria-label": "Name" } }}
                sx={{
                  flex: 1,
                  "& .MuiInput-underline:before": { borderBottomColor: "transparent" },
                  "& .MuiInput-underline:hover:before": { borderBottomColor: "primary.main" },
                  "& .MuiInputBase-input": {
                    fontWeight: isActive ? "bold" : "normal",
                    fontSize: "1rem",
                    px: 0.5,
                    py: 0,
                    height: "24px",
                    lineHeight: "24px",
                  },
                  "& .MuiInputBase-root": { mt: 0 },
                }}
              />
              {/* Clicking moves focus out of the field; its blur saves. */}
              <IconButton ref={saveButtonRef} aria-label="Save name" size="small" sx={{ ml: 0.5, color: "success.main" }}>
                <CheckIcon sx={{ fontSize: "1rem" }} />
              </IconButton>
            </>
          ) : (
            <Typography
              ref={nameLabelRef}
              variant="body1"
              onClick={isGm ? startEditing : undefined}
              onKeyDown={isGm ? handleNameLabelKeyDown : undefined}
              role={isGm ? "button" : undefined}
              tabIndex={isGm ? 0 : undefined}
              aria-label={isGm ? `Rename ${participant.name}` : undefined}
              sx={{
                fontWeight: isActive ? "bold" : "normal",
                textDecoration: participant.inactive ? "line-through" : "none",
                opacity: participant.inactive ? 0.6 : 1,
                userSelect: "none",
                cursor: isGm ? "pointer" : "default",
                flex: 1,
                px: 0.5,
                borderRadius: 1,
                "&:hover": isGm ? { backgroundColor: "action.hover" } : {},
              }}
            >
              {participant.name}
            </Typography>
          )}
        </Box>

        {isGm && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {privacyEnabled && (
              <RowAction
                title={participant.revealed ? "Hide from Players" : "Reveal to Players"}
                icon={participant.revealed ? <VisibilityIcon /> : <VisibilityOffIcon />}
                onClick={() =>
                  act(
                    `${participant.revealed ? "Hide from Players" : "Reveal to Players"}: ${participant.name}`,
                    setRevealed({ id: participant.id, value: !participant.revealed })
                  )
                }
              />
            )}

            <RowAction
              title={participant.inactive ? "Mark as Active" : "Mark as Incapacitated"}
              icon={participant.inactive ? <HeartBrokenIcon /> : <FavoriteIcon />}
              onClick={() =>
                act(
                  `${participant.inactive ? "Mark as Active" : "Mark as Incapacitated"}: ${participant.name}`,
                  setInactive({ id: participant.id, value: !participant.inactive })
                )
              }
            />

            {showHold && (
              <RowAction
                title={participant.onHold ? "Clear Hold" : "Go on Hold"}
                icon={<PanToolIcon />}
                onClick={() =>
                  act(
                    `${participant.onHold ? "Clear Hold" : "Go on Hold"}: ${participant.name}`,
                    setHold({ id: participant.id, value: !participant.onHold })
                  )
                }
              />
            )}

            {showLoseTurn && (
              <RowAction
                title="Lose Turn (Shaken/Stunned)"
                icon={<BlockIcon />}
                onClick={() => act(`Lose Turn: ${participant.name}`, loseHold(participant.id))}
              />
            )}

            {showActNow && (
              <>
                <RowAction
                  title="Act Now"
                  icon={<EastIcon />}
                  onClick={() =>
                    act(`Act Now: ${participant.name}`, insertActNow({ id: participant.id, placement: "before" }))
                  }
                />
                {activeParticipant && (
                  <RowAction
                    title="Act After Current Combatant"
                    icon={<SubdirectoryArrowRightIcon />}
                    onClick={() =>
                      act(`Act After Current Combatant: ${participant.name}`, insertActNow({ id: participant.id, placement: "after" }))
                    }
                  />
                )}
              </>
            )}
          </Box>
        )}
      </Box>
    </ListItem>
  );
};
