import { useCallback, useEffect, useRef, useState } from "react";

import OBR from "@owlbear-rodeo/sdk";

const HEIGHT_EPSILON = 1; // px
/** The action height in public/manifest.json (the maximum popover height). */
export const MANIFEST_HEIGHT = 600;

/**
 * Mirrors the natural layout height of the panel into the Owlbear Rodeo action popover.
 * Resize and mutation observers catch every layout change, so no Redux subscription is needed.
 * On unmount the popover height goes back to the manifest height.
 */
export function useObrPanelHeight(debug = false) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const participantListRef = useRef<HTMLUListElement | null>(null);
  const lastRequestedHeight = useRef<number | null>(null);
  const lastViewportHeight = useRef<number>(0);
  const measurementFrame = useRef<number | null>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  const log = useCallback(
    (...args: unknown[]) => {
      if (debug) console.debug("[Resize]", ...args);
    },
    [debug]
  );

  const measureContentHeight = useCallback(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return null;

    const participantEl = participantListRef.current;
    const participantClient = participantEl?.clientHeight ?? 0;
    const participantScroll = participantEl?.scrollHeight ?? participantClient;
    const contentHeight = Math.ceil(containerEl.scrollHeight - participantClient + participantScroll);
    log(`container=${containerEl.scrollHeight} list=${participantScroll}/${participantClient} content=${contentHeight}`);
    return contentHeight;
  }, [log]);

  const scheduleContentMeasurement = useCallback(() => {
    if (measurementFrame.current !== null) return;
    measurementFrame.current = window.requestAnimationFrame(() => {
      measurementFrame.current = null;
      const contentHeight = measureContentHeight();
      if (contentHeight == null) return;

      const previousHeight = lastRequestedHeight.current;
      if (previousHeight !== null && Math.abs(contentHeight - previousHeight) <= HEIGHT_EPSILON) return;

      lastRequestedHeight.current = contentHeight;
      OBR.action
        .setHeight(contentHeight)
        .then(() => log(`Requested OBR panel height ${contentHeight}`))
        .catch((error) => console.error("[Resize] Failed to set OBR panel height", error));
    });
  }, [measureContentHeight, log]);

  const applyViewportConstraint = useCallback(() => {
    if (!containerRef.current) return;

    if (participantListRef.current) {
      // Only cap the height when there is a scrollable list.
      const viewportHeight = Math.round(window.innerHeight);
      if (Math.abs(viewportHeight - lastViewportHeight.current) > HEIGHT_EPSILON) {
        setMaxHeight(viewportHeight);
        lastViewportHeight.current = viewportHeight;
      }
    } else if (lastViewportHeight.current !== 0) {
      setMaxHeight(undefined);
      lastViewportHeight.current = 0;
    }

    scheduleContentMeasurement();
  }, [scheduleContentMeasurement]);

  useEffect(() => {
    window.addEventListener("resize", applyViewportConstraint);
    return () => window.removeEventListener("resize", applyViewportConstraint);
  }, [applyViewportConstraint]);

  useEffect(() => {
    const target = containerRef.current;
    if (!target) return;

    const onChange = () => applyViewportConstraint();
    // ResizeObserver is in every browser OBR supports; jsdom (tests) lacks it.
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(onChange);
    resizeObserver?.observe(target);
    const mutationObserver = new MutationObserver(onChange);
    mutationObserver.observe(target, { childList: true, subtree: true });
    applyViewportConstraint();

    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
    };
  }, [applyViewportConstraint]);

  useEffect(() => {
    return () => {
      if (measurementFrame.current !== null) {
        window.cancelAnimationFrame(measurementFrame.current);
        measurementFrame.current = null;
      }
      lastRequestedHeight.current = null;
      OBR.action.setHeight(MANIFEST_HEIGHT).catch((error) => {
        console.error("[Resize] Failed to reset OBR panel height", error);
      });
    };
  }, []);

  return { containerRef, participantListRef, maxHeight };
}
