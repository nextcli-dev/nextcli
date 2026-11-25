import { isValidCommandRule } from "@continuedev/terminal-security/dist/commandRule.js";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { FormEvent, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import {
  addTrustedCommands,
  removeTrustedCommand,
} from "../../../redux/slices/uiSlice";

/** A rule that covers every subcommand of a command, such as `git*` */
const isBroadRule = (rule: string) => /^\S+\*$/.test(rule);

/**
 * The commands Run Terminal Command runs without asking, shown under its
 * policy. "Allow & don't ask again" adds to the same list.
 */
export function TrustedCommands() {
  const dispatch = useAppDispatch();
  const rules = useAppSelector((state) => state.ui.trustedCommands);
  const [draft, setDraft] = useState("");
  const rule = draft.trim();
  const invalid = rule !== "" && !isValidCommandRule(rule);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!isValidCommandRule(rule)) {
      return;
    }
    dispatch(addTrustedCommands([rule]));
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1 pb-1 pl-5 pr-2">
      <span className="text-description text-2xs">
        Runs these commands without asking: <code>git commit*</code> covers{" "}
        <code>git commit -m x</code>. A line of several commands runs only when
        every command in it is trusted, or on Automatic approved by the checks,
        and it still asks for a redirect or <code>tee</code> that writes a file,
        a pipe into a shell and broad deletes. <code>git*</code> trusts every
        git command, <code>git push --force</code> included.
      </span>
      {rules.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {rules.map((trusted) => (
            <span
              key={trusted}
              title={
                isBroadRule(trusted)
                  ? "Covers every subcommand of this command"
                  : undefined
              }
              className={`text-2xs flex items-center gap-0.5 rounded px-1.5 py-0.5 ${
                isBroadRule(trusted)
                  ? "text-warning border-warning border border-solid"
                  : "bg-badge text-badge-foreground"
              }`}
            >
              {trusted}
              <button
                type="button"
                aria-label={`Remove ${trusted}`}
                onClick={() => dispatch(removeTrustedCommand(trusted))}
                className="flex cursor-pointer items-center border-none bg-transparent p-0 text-inherit hover:opacity-80"
              >
                <XMarkIcon className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <form onSubmit={onSubmit} className="flex items-center gap-1">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a trusted command, e.g. npm test*"
          aria-label="Trusted command"
          aria-invalid={invalid}
          className={`bg-input text-input-foreground placeholder:text-input-placeholder text-2xs flex-1 rounded border border-solid px-1.5 py-0.5 outline-none ${
            invalid
              ? "border-error"
              : "border-input-border focus:border-border-focus"
          }`}
        />
        <button
          type="submit"
          disabled={!isValidCommandRule(rule)}
          className="bg-secondary text-secondary-foreground hover:bg-secondary-hover text-2xs cursor-pointer rounded border-none px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  );
}
