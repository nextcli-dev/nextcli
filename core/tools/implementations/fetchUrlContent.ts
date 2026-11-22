import { ToolImpl } from ".";
import { ContextItem, FetchFunction } from "../..";
import { getUrlContextItems } from "../../context/providers/URLContextProvider";
import { getStringArg } from "../parseArgs";

const DEFAULT_FETCH_URL_CHAR_LIMIT = 20000;
const MAX_REDIRECTS = 10;

/** A request or redirect to an origin other than the one the call named */
class LeftOriginError extends Error {
  constructor(readonly target: string) {
    super(`Request to ${target} leaves the URL's origin`);
  }
}

/**
 * A fetch that stays on one origin (scheme, host and port): it follows
 * redirects within it and refuses any request or redirect elsewhere. The
 * permission check saw only the URL the model named, so the page, its
 * redirects and the favicon lookup all stay on that URL's origin.
 */
function sameOriginFetch(
  fetchFn: FetchFunction,
  origin: string,
): FetchFunction {
  return async (input, init) => {
    let url = new URL(input);
    for (let redirects = 0; ; redirects++) {
      if (url.origin !== origin) {
        throw new LeftOriginError(url.toString());
      }
      const response = await fetchFn(url, { ...init, redirect: "manual" });
      const location: string | null =
        response.status >= 300 && response.status < 400
          ? response.headers.get("location")
          : null;
      if (!location) {
        return response;
      }
      if (redirects === MAX_REDIRECTS) {
        throw new Error(`Too many redirects from ${input}`);
      }
      url = new URL(location, url);
    }
  };
}

export const fetchUrlContentImpl: ToolImpl = async (args, extras) => {
  const url = getStringArg(args, "url");

  let contextItems: ContextItem[];
  try {
    contextItems = await getUrlContextItems(
      url,
      sameOriginFetch(extras.fetch, new URL(url).origin),
    );
  } catch (error) {
    if (error instanceof LeftOriginError) {
      return [
        {
          name: "Redirect to another site",
          description: url,
          content: `${url} redirects to ${error.target}, which is on another site, so it wasn't followed. To read it, fetch ${error.target}; that request is checked on its own.`,
        },
      ];
    }
    throw error;
  }

  // Track truncated content
  const truncatedUrls: string[] = [];

  // Check and truncate each context item
  const processedItems = contextItems.map((item) => {
    if (item.content.length > DEFAULT_FETCH_URL_CHAR_LIMIT) {
      truncatedUrls.push(url);
      return {
        ...item,
        content: item.content.substring(0, DEFAULT_FETCH_URL_CHAR_LIMIT),
      };
    }
    return item;
  });

  // Add truncation warning if needed
  if (truncatedUrls.length > 0) {
    processedItems.push({
      name: "Truncation warning",
      description: "",
      content: `The content from ${truncatedUrls.join(", ")} was truncated because it exceeded the ${DEFAULT_FETCH_URL_CHAR_LIMIT} character limit. If you need more content, consider fetching specific sections or using a more targeted approach.`,
    });
  }

  return processedItems;
};
