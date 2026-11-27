import type { ReactElement } from "react";
import { Box, Typography, type SvgIconProps } from "@mui/material";

interface PlayerPhaseMessageProps {
  icon: ReactElement<SvgIconProps>;
  title: string;
  text: string;
  align?: "left" | "center";
}

/** Centered phase message (icon + title + hint) shown instead of the combatant list. */
export function PlayerPhaseMessage({ icon, title, text, align = "center" }: PlayerPhaseMessageProps) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, py: 4, px: 4 }}>
      <Box sx={{ display: "flex", alignItems: "center", mb: 2, "& svg": { fontSize: 24, color: "text.disabled", mr: 1 } }}>
        {icon}
        <Typography variant="body1" color="text.secondary">
          {title}
        </Typography>
      </Box>
      <Typography variant="caption" color="text.disabled" align={align} sx={{ maxWidth: "300px", lineHeight: 1.4, fontSize: "0.7rem" }}>
        {text}
      </Typography>
    </Box>
  );
}
