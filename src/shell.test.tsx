// App shell pieces: PluginGate, PluginThemeProvider, AppErrorBoundary, App card-chooser route.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("./test/obrMock").then((m) => m.createSdkModule()));

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTheme } from "@mui/material/styles";
import { DEFAULT_THEME, hub, obr, resetObrMock } from "./test/obrMock";
import { PluginGate } from "./components/PluginGate";
import { PluginThemeProvider } from "./PluginThemeProvider";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { App } from "./App";
import { store } from "./store/store";
import { STATE_KEY } from "./store/syncEngine";
import { encodeEncounterState } from "./store/stateCodec";
import { initializeEmptyState } from "./store/initialState";
import { createParticipant } from "./store/swadeSlice";

// App and AppErrorBoundary use this iframe's singleton store: one mock room for the file.
beforeAll(() => {
  resetObrMock();
  const state = initializeEmptyState();
  state.phase = "cards_dealt";
  state.round = 1;
  const card = state.deck.remaining.pop()!;
  state.deck.inPlay.push(card);
  state.rows = [{ id: "r1", name: "Hero", type: "PC", inactive: false, onHold: false, revealed: true, currentCardId: card, candidateIds: [card] }];
  hub().roomMetadata = { [STATE_KEY]: encodeEncounterState({ ...state, revision: 5, writerId: "seed" }) };
});

afterEach(() => {
  window.history.pushState({}, "", "/");
  vi.restoreAllMocks();
});

describe("PluginGate", () => {
  it("renders the children after OBR is ready", async () => {
    render(<PluginGate><div>inside</div></PluginGate>);
    expect(await screen.findByText("inside")).toBeInTheDocument();
  });

  it("renders nothing outside Owlbear Rodeo", async () => {
    const client = obr();
    client.isAvailable = false;
    try {
      const { container } = render(<PluginGate><div>inside</div></PluginGate>);
      await act(async () => {});
      expect(container).toBeEmptyDOMElement();
    } finally {
      client.isAvailable = true;
    }
  });
});

describe("PluginThemeProvider", () => {
  function Mode() {
    return <span>{useTheme().palette.mode}</span>;
  }

  it("follows the OBR theme and its changes", async () => {
    render(<PluginThemeProvider><Mode /></PluginThemeProvider>);
    expect(await screen.findByText("dark")).toBeInTheDocument();
    await act(async () => {
      obr().setTheme({ ...DEFAULT_THEME, mode: "LIGHT" });
    });
    expect(await screen.findByText("light")).toBeInTheDocument();
  });

  it("keeps the default theme when the theme cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    obr().theme.getTheme.mockRejectedValueOnce(new Error("no theme"));
    render(<PluginThemeProvider><Mode /></PluginThemeProvider>);
    await act(async () => {});
    expect(screen.getByText("light")).toBeInTheDocument(); // MUI default
  });
});

describe("AppErrorBoundary", () => {
  let fail = true;
  function Bomb() {
    if (fail) throw new Error("boom");
    return <div>recovered</div>;
  }

  it("shows a fallback; Retry renders the children again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    fail = true;
    render(<AppErrorBoundary><Bomb /></AppErrorBoundary>);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });

  it("a player gets no Reset button", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    obr().setRole("PLAYER");
    fail = true;
    render(<AppErrorBoundary><Bomb /></AppErrorBoundary>);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Reset tracker" })).not.toBeInTheDocument();
    obr().setRole("GM");
  });

  it("the GM can reset the tracker, which then renders again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    fail = true;
    render(<AppErrorBoundary><Bomb /></AppErrorBoundary>);
    store.dispatch(createParticipant({ name: "X", type: "PC" }));
    const button = await screen.findByRole("button", { name: "Reset tracker" });
    fail = false;
    await user.click(button);
    expect(await screen.findByText("recovered")).toBeInTheDocument();
    expect(store.getState().swade.rows).toEqual([]);
  });
});

describe("App routing", () => {
  it("shows the card chooser for ?view=card-chooser&participantId=…", async () => {
    window.history.pushState({}, "", "/?view=card-chooser&participantId=r1");
    render(<App />);
    expect(await screen.findByText("Choose Initiative Card - Hero")).toBeInTheDocument();
  });
});
