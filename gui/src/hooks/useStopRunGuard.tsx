import { useCallback } from "react";
import { useStore } from "react-redux";
import ConfirmationDialog from "../components/dialogs/ConfirmationDialog";
import { useAppDispatch } from "../redux/hooks";
import { setDialogMessage, setShowDialog } from "../redux/slices/uiSlice";
import { RootState } from "../redux/store";

/**
 * The GUI holds one live session, so switching sessions stops a running
 * turn. Returns a guard for user-initiated switches (New Session, tabs,
 * History): it switches at once when nothing runs, and otherwise asks
 * before stopping the turn.
 */
export function useStopRunGuard() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();

  return useCallback(
    (switchSession: () => unknown) => {
      // Read at call time: handlers can outlive the render that made them
      if (!store.getState().session.isStreaming) {
        void switchSession();
        return;
      }
      dispatch(
        setDialogMessage(
          <ConfirmationDialog
            title="Stop the running turn?"
            text="The model is still working in this session. Switching stops it; the session keeps what it has so far."
            confirmText="Stop and switch"
            cancelText="Keep running"
            onConfirm={() => void switchSession()}
          />,
        ),
      );
      dispatch(setShowDialog(true));
    },
    [dispatch, store],
  );
}
