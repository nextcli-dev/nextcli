import { ArrowPathIcon, FlagIcon } from "@heroicons/react/24/outline";
import { DISCUSSIONS_LINK, GITHUB_LINK } from "core/util/constants";
import { useContext, useEffect, useState } from "react";
import { FallbackProps } from "react-error-boundary";
import { useDispatch } from "react-redux";
import { useNavigate, useRouteError } from "react-router-dom";
import { Button, SecondaryButton } from "../components";
import { GithubIcon } from "../components/svg/GithubIcon";
import { IdeMessengerContext } from "../context/IdeMessenger";

/**
 * Drops the in-memory store and the saved copy, so a crash cannot replay.
 * The store is imported on click: this module loads while the store is still
 * initializing, and a static import would run the reducers before they exist.
 */
async function recoverFromCrash(dispatch: (action: { type: string }) => void) {
  const { persistor, resetRootState } = await import("../redux/store");
  localStorage.removeItem("inputHistory_chat");
  dispatch(resetRootState());
  await persistor.purge();
}

/** Logs a crash once. The fallback renders again when the user clicks Continue. */
function useLogError(error: unknown) {
  useEffect(() => {
    console.error(error);
  }, [error]);
}

/** A thrown value may not be an Error. Reading `.message` on it would throw again. */
export function errorText(error: unknown): string {
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const record = error as { statusText?: unknown; message?: unknown };
    if (typeof record.statusText === "string" && record.statusText) {
      return record.statusText;
    }
    if (typeof record.message === "string" && record.message) {
      return record.message;
    }
  }
  return "Unknown error";
}

export function errorStack(error: unknown): string | undefined {
  if (error && typeof error === "object" && "stack" in error) {
    const stack = (error as { stack?: unknown }).stack;
    if (typeof stack === "string") return stack;
  }
  return undefined;
}

/**
 * Shown when a render throws outside a route. The route error page cannot
 * be used here: it reads the router, which this boundary replaces.
 */
export function AppErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const dispatch = useDispatch();
  useLogError(error);

  return (
    <div className="flex flex-col items-center justify-center px-2 py-4 text-center sm:px-8">
      <h1 className="mb-4 text-3xl font-bold">Oops! Something went wrong</h1>
      <code className="whitespace-wrap mx-2 mb-4 max-w-full break-words py-2">
        {errorText(error)}
      </code>
      <Button
        className="flex flex-row items-center gap-2"
        onClick={() => {
          void recoverFromCrash(dispatch).finally(resetErrorBoundary);
        }}
      >
        <ArrowPathIcon className="h-5 w-5" />
        Continue
      </Button>
    </div>
  );
}

const ErrorPage: React.FC = () => {
  const error: unknown = useRouteError();
  useLogError(error);
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const messenger = useContext(IdeMessengerContext);
  const openUrl = (url: string) => {
    if (messenger) {
      messenger.post("openUrl", url);
    }
  };

  const [initialLoad, setInitialLoad] = useState(true);

  useEffect(() => {
    setTimeout(() => {
      setInitialLoad(false);
    }, 500);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center px-2 py-4 text-center sm:px-8">
      <h1 className="mb-4 text-3xl font-bold">Oops! Something went wrong</h1>

      <code className="whitespace-wrap mx-2 mb-4 max-w-full break-words py-2">
        {errorText(error)}
      </code>

      <Button
        className="flex flex-row items-center gap-2"
        onClick={() => {
          void recoverFromCrash(dispatch).finally(() => navigate("/"));
        }}
      >
        {initialLoad ? (
          <FlagIcon className="h-5 w-5 text-red-600" />
        ) : (
          <ArrowPathIcon className="h-5 w-5" />
        )}
        Continue
      </Button>
    </div>
  );
};

export default ErrorPage;
