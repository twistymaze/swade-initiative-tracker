// saveChanges with the real store and sync engine (flushSync is not mocked).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));
// No background page: the modal saves itself (fallback path, with the settle delay).
vi.mock("../actionChannel", () => ({ sendToBackground: vi.fn(async () => "unavailable") }));

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider } from "react-redux";
import { hub, obr, resetObrMock } from "../test/obrMock";
import { startSync, store, syncEngine, writerId } from "../store/store";
import { STATE_KEY } from "../store/syncEngine";
import { parseEncounterState } from "../store/stateCodec";
import { createParticipant } from "../store/swadeSlice";
import { LocalUndoStore } from "../store/localUndoStore";
import { UndoProvider } from "../contexts/UndoContext";
import { AddParticipantModal } from "../components/AddParticipantModal";
import { saveChanges, SETTLE_MS } from "./saveChanges";

const roomRows = () => {
  const result = parseEncounterState(hub().roomMetadata[STATE_KEY]);
  return result.kind === "ok" ? result.state.rows.map((r) => r.name) : [];
};

const hostError = () => ({ error: { name: "Unknown", message: "refused" } });

// One room and one store singleton for the whole file (the singleton cannot restart).
beforeAll(async () => {
  resetObrMock();
  sessionStorage.clear();
  obr().setRole("GM");
  await startSync();
  await vi.waitFor(() => expect(syncEngine.getSnapshot().status).toBe("ready"));
  await saveChanges("setup"); // the GM writes the fresh room state
});

afterAll(() => {
  syncEngine.stop();
});

describe("saveChanges", () => {
  it("writes again after a failed write (R3-S3)", async () => {
    obr().failRoom("setMetadata", hostError());
    store.dispatch(createParticipant({ name: "Orc", type: "NPC" }));
    expect(await saveChanges("test")).toBe(false);
    expect(syncEngine.getSnapshot().status).toBe("error");
    expect(roomRows()).toEqual([]);

    expect(await saveChanges("test")).toBe(true);
    expect(roomRows()).toEqual(["Orc"]);
    expect(syncEngine.getSnapshot().status).toBe("ready");
  });

  it("Add Combatant: Try again saves the combatant and closes the modal", async () => {
    const user = userEvent.setup();
    const undoStore = new LocalUndoStore({ store, writerId, roomId: "room-test" });
    render(
      <Provider store={store}>
        <UndoProvider undoStore={undoStore}>
          <AddParticipantModal />
        </UndoProvider>
      </Provider>
    );
    obr().failRoom("setMetadata", hostError());
    await user.type(screen.getByRole("textbox", { name: /name/i }), "Goblin");
    await user.click(screen.getByRole("button", { name: "+NPC" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    expect(obr().modal.close).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => {
      await vi.waitFor(() => expect(obr().modal.close).toHaveBeenCalled(), { timeout: SETTLE_MS + 1500 });
    });
    expect(roomRows()).toContain("Goblin");
  });
});
