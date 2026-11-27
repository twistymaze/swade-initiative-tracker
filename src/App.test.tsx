import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("./test/obrMock").then((m) => m.createSdkModule()));

import { render, screen } from "@testing-library/react";
import { resetObrMock } from "./test/obrMock";
import { App } from "./App";

// App uses this iframe's singleton store and sync engine: one mock room for the whole file.
beforeAll(() => {
  resetObrMock();
});

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("App routing", () => {
  it("shows the tracker by default", async () => {
    render(<App />);
    expect(await screen.findByText("Initiative")).toBeInTheDocument();
  });

  it("shows the add combatant modal for ?view=add-participant", async () => {
    window.history.pushState({}, "", "/?view=add-participant");
    render(<App />);
    expect(await screen.findByText("Add Combatant")).toBeInTheDocument();
  });

  it("no longer routes the legacy path form", async () => {
    window.history.pushState({}, "", "/add-participant");
    render(<App />);
    expect(await screen.findByText("Initiative")).toBeInTheDocument();
    expect(screen.queryByText("Add Combatant")).not.toBeInTheDocument();
  });
});
