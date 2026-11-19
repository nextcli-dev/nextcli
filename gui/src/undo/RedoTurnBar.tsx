import { ArrowUturnRightIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { applyRedo } from "./turnSnapshot";

export function RedoTurnBar() {
  const dispatch = useAppDispatch();
  const undoneTurn = useAppSelector((state) => state.session.undoneTurn);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!undoneTurn) return null;

  return (
    <div
      className="text-description mx-2 mb-1 flex items-center justify-between gap-2 text-xs"
      data-testid="redo-turn-bar"
    >
      <span>{error ?? "Undone. Sending a new message makes this final."}</span>
      <button
        className="text-link flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-xs disabled:opacity-50"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await dispatch(applyRedo()).unwrap();
          } catch (e) {
            setError(`Redo failed: ${(e as Error).message}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ArrowUturnRightIcon className="h-3.5 w-3.5" />
        Redo
      </button>
    </div>
  );
}
