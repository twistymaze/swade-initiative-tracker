import type { ReactNode } from "react";
import { IconButton, Tooltip } from "@mui/material";

interface RowActionProps {
  /** Tooltip and accessible name. */
  title: string;
  icon: ReactNode;
  onClick: () => void;
}

/** Small icon button for a participant row action (keyboard and touch reachable). */
export function RowAction({ title, icon, onClick }: RowActionProps) {
  return (
    <Tooltip disableInteractive title={title}>
      <IconButton
        aria-label={title}
        onClick={onClick}
        size="small"
        sx={{
          p: 0.25,
          color: "text.secondary",
          opacity: 0.5,
          transition: "opacity 0.2s, color 0.2s",
          "&:hover, &:focus-visible": { opacity: 1, color: "primary.main" },
          "& .MuiSvgIcon-root": { fontSize: "1rem" },
        }}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
}
