import { useState, type Ref } from "react";
import { Box, List, Typography } from "@mui/material";
import GroupAddIcon from "@mui/icons-material/GroupAdd";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";

import { useAppSelector } from "../store/hooks";
import { selectVisibleParticipants } from "../store/selectors";
import { ParticipantRow } from "./ParticipantRow";

interface ParticipantListProps {
  role?: "GM" | "PLAYER";
  ref?: Ref<HTMLUListElement>;
}

export function ParticipantList({ role, ref }: ParticipantListProps) {
  const participants = useAppSelector((state) => selectVisibleParticipants(state, role));
  const [editingId, setEditingId] = useState<string | null>(null);

  if (participants.length === 0 && role !== "GM") {
    // Neutral for players: with privacy on, hidden rows must not be hinted at either way.
    return (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100%", py: 4, px: 3 }}>
        <HourglassEmptyIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
        <Typography variant="body1" color="text.secondary" align="center">
          Waiting for the GM
        </Typography>
        <Typography variant="caption" color="text.disabled" align="center" sx={{ mt: 0.5 }}>
          Combatants appear here as the GM shows them
        </Typography>
      </Box>
    );
  }

  if (participants.length === 0) {
    return (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100%", py: 4, px: 3 }}>
        <GroupAddIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
        <Typography variant="body1" color="text.secondary" align="center">
          No combatants added
        </Typography>
        <Typography variant="caption" color="text.disabled" align="center" sx={{ mt: 0.5 }}>
          Add combatants to start initiative
        </Typography>
      </Box>
    );
  }

  return (
    <List ref={ref} sx={{ overflow: "auto", flex: 1, scrollbarGutter: "stable" }}>
      {participants.map((participant) => (
        <ParticipantRow
          key={participant.id}
          participant={participant}
          role={role}
          editingId={editingId}
          setEditingId={setEditingId}
        />
      ))}
    </List>
  );
}
