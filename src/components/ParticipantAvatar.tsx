import { useState } from "react";
import { Avatar, useTheme } from "@mui/material";
import PersonIcon from "@mui/icons-material/Person";
import type { ParticipantType } from "../store/types";

interface ParticipantAvatarProps {
  imageUrl?: string;
  name: string;
  type: ParticipantType;
  size?: number;
}

/**
 * Token image (or a default icon) with a border colour by participant type.
 * Give it `key={imageUrl}` so a failed image does not stick after the URL changes.
 */
export function ParticipantAvatar({ imageUrl, name, type, size = 32 }: ParticipantAvatarProps) {
  const theme = useTheme();
  const [hasImageError, setHasImageError] = useState(false);

  const validImageUrl = imageUrl?.trim() && !hasImageError ? imageUrl : undefined;
  const borderColor =
    type === "PC" ? theme.palette.success.main : type === "NPC" ? theme.palette.info.main : theme.palette.text.disabled;

  return (
    <Avatar
      src={validImageUrl}
      alt={`${name} avatar`}
      slotProps={{ img: { onError: () => setHasImageError(true) } }}
      sx={{
        width: size,
        height: size,
        bgcolor: "background.paper",
        boxShadow: `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${borderColor}`,
        "& img": { objectFit: "cover" },
      }}
    >
      {!validImageUrl && <PersonIcon sx={{ fontSize: size * 0.7, color: "text.secondary" }} />}
    </Avatar>
  );
}
