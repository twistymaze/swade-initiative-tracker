import { ReactNode } from "react";
import { Alert, Box, Button, CircularProgress, Typography } from "@mui/material";
import { store, useSyncStatus } from "../store/store";
import { reset } from "../store/swadeSlice";
import { useRole } from "../hooks/useRole";

function Panel({ severity, title, children }: { severity: "info" | "warning" | "error"; title: string; children?: ReactNode }) {
  return (
    <Box sx={{ p: 2 }}>
      <Alert severity={severity}>
        <Typography variant="subtitle2" gutterBottom>
          {title}
        </Typography>
        {children}
      </Alert>
    </Box>
  );
}

/**
 * Shows the tracker (or a modal) only after the room state was loaded, and a panel
 * when the room cannot be read, holds a newer version (a newer state version or sync
 * protocol: the panel stays until the page is reloaded), or holds unreadable data.
 * Write problems (status `error` / `too-large` after load) do not hide the UI.
 */
export function SyncStatusGate({ children }: { children: ReactNode }) {
  const { status, loaded } = useSyncStatus();
  const isGm = useRole() === "GM";

  if (!loaded) {
    if (status === "error") {
      return (
        <Panel severity="error" title="Cannot reach the room">
          <Typography variant="body2">Still trying to load the initiative tracker…</Typography>
        </Panel>
      );
    }
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
        <CircularProgress size={24} aria-label="Loading" />
      </Box>
    );
  }

  if (status === "too-new") {
    return (
      <Panel severity="warning" title="A newer version of the initiative tracker is in use">
        <Typography variant="body2">Reload this page to update.</Typography>
      </Panel>
    );
  }

  if (status === "invalid") {
    return (
      <Panel severity="error" title="Tracker data cannot be read">
        {isGm ? (
          <Button size="small" color="inherit" variant="outlined" sx={{ mt: 1 }} onClick={() => store.dispatch(reset())}>
            Reset tracker
          </Button>
        ) : (
          <Typography variant="body2">Ask the GM to reset the tracker.</Typography>
        )}
      </Panel>
    );
  }

  return <>{children}</>;
}
