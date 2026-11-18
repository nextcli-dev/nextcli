import { useEffect, useState } from "react";
import { useAppDispatch } from "../../redux/hooks";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import {
  applyUndo,
  planUndo,
  UndoMode,
  UndoPlan,
} from "../../redux/thunks/turnSnapshot";
import { Button } from "../ui/Button";

const MAX_FILES_SHOWN = 12;

function FileList({
  label,
  files,
  className,
}: {
  label: string;
  files: string[];
  className?: string;
}) {
  if (files.length === 0) return null;
  const shown = files.slice(0, MAX_FILES_SHOWN);
  return (
    <div className="mt-3">
      <div className={className}>
        {label} ({files.length})
      </div>
      <ul className="m-0 list-none p-0 font-mono text-xs">
        {shown.map((file) => (
          <li key={file} className="truncate">
            {file}
          </li>
        ))}
        {files.length > shown.length && (
          <li className="text-description">
            …and {files.length - shown.length} more
          </li>
        )}
      </ul>
    </div>
  );
}

/** Prefixes paths with their folder name when several repositories are open. */
function filesOf(plan: UndoPlan, key: "restore" | "delete" | "conflicts") {
  const many = plan.roots.length > 1;
  return plan.roots.flatMap(({ root, plan: p }) => {
    const folder = root.split(/[\\/]/).pop() ?? root;
    return p[key].map((file) => (many ? `${folder}/${file}` : file));
  });
}

/**
 * Shows what undoing every turn from a message on would change, then
 * restores code and conversation, or code only.
 */
export function UndoTurnDialog({ fromIndex }: { fromIndex: number }) {
  const dispatch = useAppDispatch();
  const [plan, setPlan] = useState<UndoPlan>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dispatch(planUndo({ fromIndex }))
      .unwrap()
      .then(setPlan)
      .catch((e: Error) => setError(e.message));
  }, [dispatch, fromIndex]);

  const close = () => {
    dispatch(setShowDialog(false));
    dispatch(setDialogMessage(undefined));
  };

  const confirm = async (mode: UndoMode) => {
    if (!plan) return;
    setBusy(true);
    try {
      await dispatch(applyUndo({ plan, mode })).unwrap();
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const restore = plan ? filesOf(plan, "restore") : [];
  const remove = plan ? filesOf(plan, "delete") : [];
  const conflicts = plan ? filesOf(plan, "conflicts") : [];

  return (
    <div className="p-4 pt-0" data-testid="undo-turn-dialog">
      <h1 className="mb-1 text-center text-xl">
        {plan && plan.turns > 1 ? `Undo ${plan.turns} turns` : "Undo turn"}
      </h1>
      {error && <p className="text-error text-center">{error}</p>}
      {!plan && !error && (
        <p className="text-description text-center">
          Working out what to restore…
        </p>
      )}
      {plan && (
        <div className="text-sm">
          {restore.length + remove.length === 0 && (
            <p>These turns changed no files.</p>
          )}
          <FileList label="Put back" files={restore} className="text-success" />
          <FileList
            label="Delete (created by the agent)"
            files={remove}
            className="text-error"
          />
          <FileList
            label="Changed since the agent wrote them, will be overwritten"
            files={conflicts}
            className="text-warning"
          />
          <p className="text-description mt-3 text-xs">
            Unsaved changes in these files are replaced. Files outside git,
            ignored files and submodules aren't restored.
          </p>
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="outline"
          disabled={!plan || busy}
          onClick={() => void confirm("code")}
        >
          Restore code only
        </Button>
        <Button
          disabled={!plan || busy}
          onClick={() => void confirm("code-and-conversation")}
        >
          Restore code and conversation
        </Button>
      </div>
    </div>
  );
}
