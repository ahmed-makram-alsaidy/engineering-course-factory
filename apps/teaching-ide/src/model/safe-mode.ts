// Recording Safe Mode — UI state that prepares the layout for future screen
// recording: development/debug surfaces hide, instructional content dominates.
// This is display state only; nothing is captured or recorded in P4.

export interface SafeModeState {
  recordingSafe: boolean;
  /** Development panels (inspector, fixture selector). */
  devPanels: boolean;
}

export const initialSafeModeState: SafeModeState = { recordingSafe: false, devPanels: true };

export function setRecordingSafe(state: SafeModeState, recordingSafe: boolean): SafeModeState {
  return { ...state, recordingSafe };
}

export interface PanelVisibility {
  inspector: boolean;
  fixtureSelector: boolean;
  devBadge: boolean;
}

/** Derived visibility of dev-only surfaces. Recording safe mode always hides them. */
export function panelVisibility(state: SafeModeState): PanelVisibility {
  return {
    inspector: state.devPanels && !state.recordingSafe,
    fixtureSelector: state.devPanels && !state.recordingSafe,
    devBadge: state.devPanels && !state.recordingSafe,
  };
}
