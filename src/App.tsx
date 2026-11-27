import { useEffect } from "react";
import { Provider } from "react-redux";
import { InitiativeTracker } from "./InitiativeTracker";
import { startSync, store } from "./store/store";
import { AddParticipantModal } from "./components/AddParticipantModal";
import { CardChooserModal } from "./components/CardChooserModal";
import { UndoProvider } from "./contexts/UndoContext";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { SyncStatusGate } from "./components/SyncStatusGate";

/** Which view this iframe shows: `/?view=add-participant`, `/?view=card-chooser&participantId=…`, or the tracker. */
function getView(): string | null {
  return new URLSearchParams(window.location.search).get("view");
}

/** Rendered inside PluginGate (main.tsx), so OBR is ready. */
export function App() {
  useEffect(() => {
    startSync().catch((error) => console.error("[sync] failed to start", error));
  }, []);

  const view = getView();

  return (
    <Provider store={store}>
      <AppErrorBoundary>
        <SyncStatusGate>
          <UndoProvider>
            {view === "add-participant" ? (
              <AddParticipantModal />
            ) : view === "card-chooser" ? (
              <CardChooserModal />
            ) : (
              <InitiativeTracker />
            )}
          </UndoProvider>
        </SyncStatusGate>
      </AppErrorBoundary>
    </Provider>
  );
}
