import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@owlbear-rodeo/sdk", () => import("../test/obrMock").then((m) => m.createSdkModule()));

import { act, render } from "@testing-library/react";
import { Provider } from "react-redux";
import { flushObr, obr, resetObrMock } from "../test/obrMock";
import { createAppStore } from "../store/store";
import { setPrivacy } from "../store/swadeSlice";
import { MANIFEST_HEIGHT, useObrPanelHeight } from "./useObrPanelHeight";

let renders = 0;

function Panel() {
  renders++;
  const { containerRef, participantListRef, maxHeight } = useObrPanelHeight();
  return (
    <div ref={containerRef} style={{ maxHeight }}>
      <ul ref={participantListRef} />
    </div>
  );
}

beforeEach(() => {
  resetObrMock();
  renders = 0;
});

describe("useObrPanelHeight", () => {
  it("does not re-render on an unrelated store change", async () => {
    const store = createAppStore({ writerId: "me", getMinRevision: () => 0 });
    render(
      <Provider store={store}>
        <Panel />
      </Provider>
    );
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    const before = renders;

    act(() => {
      store.dispatch(setPrivacy(false));
    });

    expect(store.getState().swade.revision).toBeGreaterThan(0);
    expect(renders).toBe(before);
  });

  it("requests the measured height, then resets to the manifest height on unmount", async () => {
    const { unmount } = render(<Panel />);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(obr().action.setHeight).toHaveBeenCalledTimes(1);

    unmount();
    await flushObr();

    expect(obr().action.setHeight).toHaveBeenLastCalledWith(MANIFEST_HEIGHT);
  });
});

describe("useObrPanelHeight viewport cap", () => {
  function Capped({ withList }: { withList: boolean }) {
    const { containerRef, participantListRef, maxHeight } = useObrPanelHeight();
    return (
      <div data-testid="panel" ref={containerRef} style={{ maxHeight }}>
        {withList && <ul ref={participantListRef} />}
      </div>
    );
  }

  const setViewport = (height: number) => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    window.dispatchEvent(new Event("resize"));
  };

  it("caps the panel at the viewport height while a list is shown, and follows resizes", async () => {
    const original = window.innerHeight;
    try {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
      const { getByTestId, rerender } = render(<Capped withList />);
      await act(async () => {});
      expect(getByTestId("panel").style.maxHeight).toBe("500px");

      act(() => setViewport(420));
      expect(getByTestId("panel").style.maxHeight).toBe("420px");

      // Without a list there is nothing to scroll: no cap.
      rerender(<Capped withList={false} />);
      act(() => setViewport(400));
      expect(getByTestId("panel").style.maxHeight).toBe("");
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: original });
    }
  });
});

describe("InitiativeTracker (popover)", () => {
  it("does not register context menus (the background page does)", async () => {
    const { InitiativeTracker } = await import("../InitiativeTracker");
    const { UndoProvider } = await import("../contexts/UndoContext");
    const { store } = await import("../store/store");
    render(
      <Provider store={store}>
        <UndoProvider>
          <InitiativeTracker />
        </UndoProvider>
      </Provider>
    );
    await act(async () => {
      await flushObr();
    });

    expect(obr().contextMenu.create).not.toHaveBeenCalled();
  });
});
