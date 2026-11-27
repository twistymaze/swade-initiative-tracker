// Undo Context Definition
// React context definition for undo functionality

import { createContext } from 'react';

export interface UndoContextValue {
  /** True only while the room still holds the state the last checkpointed action produced. */
  canUndo: boolean;
  undoDescription: string | null;
  performUndo: () => void;
  /** Call right before dispatching the action, in the same event handler. */
  captureCheckpoint: (description: string) => void;
  clearUndoHistory: () => void;
  /** Remove the top checkpoint if it is this iframe's own unsaved change (see LocalUndoStore). */
  discardOwnCheckpoint: () => void;
}

export const UndoContext = createContext<UndoContextValue | null>(null);
