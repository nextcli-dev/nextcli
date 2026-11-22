import { XMarkIcon } from "@heroicons/react/24/outline";
import { normalizeTrustedHost } from "core/tools/policies/fetchAccess";
import { FormEvent, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import {
  addTrustedFetchHost,
  removeTrustedFetchHost,
} from "../../../redux/slices/uiSlice";

/**
 * The hosts Read URL fetches from without asking, shown under its policy.
 */
export function TrustedFetchHosts() {
  const dispatch = useAppDispatch();
  const hosts = useAppSelector((state) => state.ui.trustedFetchHosts);
  const [draft, setDraft] = useState("");
  const invalid = draft.trim() !== "" && !normalizeTrustedHost(draft);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!normalizeTrustedHost(draft)) {
      return;
    }
    dispatch(addTrustedFetchHost(draft));
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1 pb-1 pl-5 pr-2">
      <span className="text-description text-2xs">
        Runs without asking for https URLs on these hosts. A URL can carry data
        out, and a page's text goes to the model without you seeing the URL
        first; add only hosts you trust. *.example.com trusts every subdomain,
        including ones where other people publish (gist.github.com under
        *.github.com).
      </span>
      {hosts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {hosts.map((host) => (
            <span
              key={host}
              className="bg-badge text-badge-foreground text-2xs flex items-center gap-0.5 rounded px-1.5 py-0.5"
            >
              {host}
              <button
                type="button"
                aria-label={`Remove ${host}`}
                onClick={() => dispatch(removeTrustedFetchHost(host))}
                className="text-badge-foreground flex cursor-pointer items-center border-none bg-transparent p-0 hover:opacity-80"
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
          placeholder="Add a trusted host, e.g. github.com"
          aria-label="Trusted host"
          aria-invalid={invalid}
          className={`bg-input text-input-foreground placeholder:text-input-placeholder text-2xs flex-1 rounded border border-solid px-1.5 py-0.5 outline-none ${
            invalid
              ? "border-error"
              : "border-input-border focus:border-border-focus"
          }`}
        />
        <button
          type="submit"
          disabled={!normalizeTrustedHost(draft)}
          className="bg-secondary text-secondary-foreground hover:bg-secondary-hover text-2xs cursor-pointer rounded border-none px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </form>
    </div>
  );
}
