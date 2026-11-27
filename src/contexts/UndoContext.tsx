// Undo Context Provider
// Exposes this iframe's LocalUndoStore (see src/store/localUndoStore.ts) to React.

import { useState, useEffect, useMemo, useCallback, useSyncExternalStore, type ReactNode } from 'react';
import OBR from '@owlbear-rodeo/sdk';
import { store, syncEngine, writerId } from '../store/store';
import { LocalUndoStore } from '../store/localUndoStore';
import { UndoContext, type UndoContextValue } from './UndoContextDefinition';

interface UndoProviderProps {
  children: ReactNode;
  /** For tests: use this store instead of one bound to this iframe's Redux store. */
  undoStore?: LocalUndoStore;
}

function createIframeUndoStore(): LocalUndoStore {
  return new LocalUndoStore({
    store,
    writerId,
    roomId: OBR.room.id,
    getRoomIdentity: () => syncEngine.getRoomIdentity(),
  });
}

export function UndoProvider({ children, undoStore: injected }: UndoProviderProps) {
  const [undoStore] = useState(() => injected ?? createIframeUndoStore());

  useEffect(() => {
    undoStore.start();
    return () => undoStore.destroy();
  }, [undoStore]);

  const subscribe = useCallback((onChange: () => void) => undoStore.subscribe(onChange), [undoStore]);
  const canUndo = useSyncExternalStore(subscribe, () => undoStore.canUndo());
  const undoDescription = useSyncExternalStore(subscribe, () => undoStore.getUndoDescription());

  const performUndo = useCallback(() => {
    undoStore.performUndo();
  }, [undoStore]);

  const captureCheckpoint = useCallback(
    (description: string) => undoStore.captureCheckpoint(description),
    [undoStore]
  );

  const clearUndoHistory = useCallback(() => undoStore.clearCheckpoints(), [undoStore]);
  const discardOwnCheckpoint = useCallback(() => {
    undoStore.discardOwnTopCheckpoint();
  }, [undoStore]);

  const value = useMemo<UndoContextValue>(
    () => ({ canUndo, undoDescription, performUndo, captureCheckpoint, clearUndoHistory, discardOwnCheckpoint }),
    [canUndo, undoDescription, performUndo, captureCheckpoint, clearUndoHistory, discardOwnCheckpoint]
  );

  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}
