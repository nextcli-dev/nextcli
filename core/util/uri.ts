import * as URI from "uri-js";

/** Converts any OS path to cleaned up URI path segment format with no leading/trailing slashes
   e.g. \path\to\folder\ -> path/to/folder
        \this\is\afile.ts -> this/is/afile.ts
        is/already/clean -> is/already/clean
  **/
export function pathToUriPathSegment(path: string) {
  let clean = path.replace(/[\\]/g, "/"); // backslashes -> forward slashes
  clean = clean.replace(/^\//, ""); // remove start slash
  clean = clean.replace(/\/$/, ""); // remove end slash
  return clean
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function getCleanUriPath(uri: string) {
  const path = URI.parse(uri).path ?? "";
  let clean = path.replace(/^\//, ""); // remove start slash
  clean = clean.replace(/\/$/, ""); // remove end slash
  return clean;
}

/** The URI's path split into encoded parts; an empty path has no parts */
function getUriPathParts(uri: string): string[] {
  const clean = getCleanUriPath(uri);
  return clean === "" ? [] : clean.split("/");
}

function getUriAuthority(comps: URI.URIComponents): string {
  let host = (comps.host ?? "").toLowerCase();
  // file://localhost/path is the same as file:///path
  if (comps.scheme === "file" && host === "localhost") {
    host = "";
  }
  return `${comps.userinfo ?? ""}@${host}:${comps.port ?? ""}`;
}

export function findUriInDirs(
  uri: string,
  dirUriCandidates: string[],
): {
  uri: string;
  relativePathOrBasename: string;
  foundInDir: string | null;
} {
  const uriComps = URI.parse(uri);
  if (!uriComps.scheme) {
    throw new Error(`Invalid uri: ${uri}`);
  }
  const uriPathParts = getUriPathParts(uri);

  for (const dir of dirUriCandidates) {
    const dirComps = URI.parse(dir);

    if (!dirComps.scheme) {
      throw new Error(`Invalid uri: ${dir}`);
    }

    // Virtual filesystems often put the root in the authority
    // (e.g. adt://<system>/...), so different hosts are different roots
    if (
      uriComps.scheme !== dirComps.scheme ||
      getUriAuthority(uriComps) !== getUriAuthority(dirComps)
    ) {
      continue;
    }
    // Can't just use startsWith because e.g.
    // file:///folder/file is not within file:///fold

    // At this point we break the path up and check if each dir path part matches.
    // A root with an empty path (adt://sys, file:///) contains everything below it
    const dirPathParts = getUriPathParts(dir);

    if (uriPathParts.length < dirPathParts.length) {
      continue;
    }
    let allDirPartsMatch = true;
    for (let i = 0; i < dirPathParts.length; i++) {
      if (dirPathParts[i] !== uriPathParts[i]) {
        allDirPartsMatch = false;
      }
    }
    if (allDirPartsMatch) {
      const relativePath = uriPathParts
        .slice(dirPathParts.length)
        .map(decodeURIComponent)
        .join("/");
      return {
        uri,
        relativePathOrBasename: relativePath,
        foundInDir: dir,
      };
    }
  }
  // Not found
  return {
    uri,
    relativePathOrBasename: getUriPathBasename(uri),
    foundInDir: null,
  };
}

/** A URI scheme has at least two characters, so `C:\a` is not a URI */
export function hasUriScheme(pathOrUri: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(pathOrUri);
}

/** A Windows drive-letter path, a UNC path or a POSIX absolute path */
export function isAbsoluteLocalPath(path: string): boolean {
  return (
    /^[a-zA-Z]:([\\/]|$)/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("/")
  );
}

/** Decodes each run of %XX escapes on its own and keeps an escape that isn't
  valid UTF-8, as vscode.Uri does, so a check sees the path VS Code opens */
function percentDecode(value: string): string {
  return value.replace(/(%[0-9A-Fa-f]{2})+/g, decodeEscapes);
}

function decodeEscapes(escapes: string): string {
  try {
    return decodeURIComponent(escapes);
  } catch {
    return escapes.length > 3
      ? escapes.slice(0, 3) + decodeEscapes(escapes.slice(3))
      : escapes;
  }
}

/** Splits a "/"-separated path, resolving "." and ".." parts.
  ".." never goes above a drive letter, a UNC share or "/"; a relative
  path keeps its leading ".." parts. */
function normalizePathParts(path: string): { prefix: string; parts: string[] } {
  const prefix = path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  const isDrivePath = /^[a-zA-Z]:/.test(path);
  // Parts that make up the root: "c:", or "server/share" for UNC
  const rootLength = isDrivePath ? 1 : prefix === "//" ? 2 : 0;
  for (const part of path.slice(prefix.length).split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > rootLength && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (prefix === "" && !isDrivePath) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  return { prefix, parts };
}

/**
  A decoded, "/"-separated form of a URI's path or of an OS path, so that
  paths written in different forms can be compared:
    file:///c%3A/My%20Projects/a.ts and C:\My Projects\a.ts -> c:/My Projects/a.ts
    file://server/share/a.ts and \\server\share\a.ts -> //server/share/a.ts
  The scheme and a remote authority (vscode-remote://wsl+x) are dropped; use
  findLocalPathInDirs to match a URI against directories of the same root.
  A "\" is a separator in a URI too (file:///c%3A/proj/..%5Ca.ts), because
  Windows reads the decoded path that way.
**/
export function localPathKey(pathOrUri: string): string {
  let path: string;
  if (hasUriScheme(pathOrUri)) {
    const comps = URI.parse(pathOrUri);
    path = percentDecode(comps.path ?? "");
    const host = (comps.host ?? "").toLowerCase();
    if (comps.scheme === "file" && host && host !== "localhost") {
      path = `//${host}${path}`;
    }
  } else {
    path = pathOrUri;
  }
  path = path.replace(/\\/g, "/").replace(/^\/([a-zA-Z]:)/, "$1");
  if (/^[a-zA-Z]:/.test(path)) {
    path = path[0].toLowerCase() + path.slice(1);
  }
  const { prefix, parts } = normalizePathParts(path);
  return prefix + parts.join("/");
}

/** Windows paths (drive letters and UNC shares) ignore case */
function isCaseInsensitiveKey(key: string): boolean {
  return /^[a-z]:/.test(key) || key.startsWith("//");
}

function foldKey(key: string, caseInsensitive: boolean): string {
  return caseInsensitive ? key.toLowerCase() : key;
}

/** Whether two URIs or OS paths name the same file */
export function isSameLocalPath(a: string, b: string): boolean {
  const keyA = localPathKey(a);
  const keyB = localPathKey(b);
  const caseInsensitive = isCaseInsensitiveKey(keyA);
  return foldKey(keyA, caseInsensitive) === foldKey(keyB, caseInsensitive);
}

/** Whether a URI or OS path ends with a relative path, whole part by part:
  file:///c%3A/My%20Projects/src/a.ts ends with src\a.ts, not with c\a.ts */
export function localPathEndsWith(
  uriOrPath: string,
  relativePath: string,
): boolean {
  const suffix = localPathKey(relativePath);
  if (
    suffix === "" ||
    isAbsoluteLocalPath(suffix) ||
    suffix === ".." ||
    suffix.startsWith("../")
  ) {
    return false;
  }
  const key = localPathKey(uriOrPath);
  const caseInsensitive = isCaseInsensitiveKey(key);
  const foldedKey = foldKey(key, caseInsensitive);
  const foldedSuffix = foldKey(suffix, caseInsensitive);
  return foldedKey === foldedSuffix || foldedKey.endsWith(`/${foldedSuffix}`);
}

/**
  Finds the directory that contains an absolute OS path or a URI, comparing
  decoded paths, so C:\proj\a.ts is found in file:///c%3A/proj. A URI only
  matches directories with the same scheme and authority; an OS path matches
  a directory with the same path under any scheme, so /home/me/a.ts is found
  in vscode-remote://wsl+ubuntu/home/me.
  Returns the decoded path relative to that directory.
**/
export function findLocalPathInDirs(
  pathOrUri: string,
  dirUriCandidates: string[],
): { dirUri: string; relativePath: string } | undefined {
  const inputComps = hasUriScheme(pathOrUri) ? URI.parse(pathOrUri) : undefined;
  if (!inputComps && !isAbsoluteLocalPath(pathOrUri)) {
    return undefined;
  }
  const { prefix, parts } = normalizePathParts(localPathKey(pathOrUri));

  for (const dirUri of dirUriCandidates) {
    if (inputComps) {
      const dirComps = URI.parse(dirUri);
      if (
        inputComps.scheme !== dirComps.scheme ||
        getUriAuthority(inputComps) !== getUriAuthority(dirComps)
      ) {
        continue;
      }
    }
    const dirKey = localPathKey(dirUri);
    const dir = normalizePathParts(dirKey);
    const caseInsensitive = isCaseInsensitiveKey(dirKey);
    if (
      dir.prefix !== prefix ||
      dir.parts.length > parts.length ||
      dir.parts.some(
        (part, i) =>
          foldKey(part, caseInsensitive) !== foldKey(parts[i], caseInsensitive),
      )
    ) {
      continue;
    }
    return {
      dirUri,
      relativePath: parts.slice(dir.parts.length).join("/"),
    };
  }
  return undefined;
}

/**
  The URI of an absolute OS path or of a URI, rebuilt from its localPathKey so
  that no ".", ".." or "\" is left in it: the URI a check sees is the URI that
  gets opened. An OS path takes the scheme and authority of the first workspace
  folder, so /tmp/a.ts is vscode-remote://wsl%2Bubuntu/tmp/a.ts in a WSL window;
  a UNC path keeps its server. A URI must use the file scheme or the scheme and
  authority of a workspace folder. Returns undefined for any other URI
  (vscode-userdata:, untitled:) and for a relative path.
**/
export function localPathToUri(
  pathOrUri: string,
  workspaceDirs: string[],
): string | undefined {
  const inputComps = hasUriScheme(pathOrUri) ? URI.parse(pathOrUri) : undefined;
  let rootUri = workspaceDirs[0] ?? "file:///";
  if (inputComps) {
    const isWorkspaceRoot = workspaceDirs.some((dir) => {
      const dirComps = URI.parse(dir);
      return (
        dirComps.scheme === inputComps.scheme &&
        getUriAuthority(dirComps) === getUriAuthority(inputComps)
      );
    });
    if (inputComps.scheme !== "file" && !isWorkspaceRoot) {
      return undefined;
    }
    rootUri = pathOrUri;
  } else if (!isAbsoluteLocalPath(pathOrUri)) {
    return undefined;
  }

  const key = localPathKey(pathOrUri);
  if (key.startsWith("//")) {
    // A UNC path: \\server\share\a.ts or file://server/share/a.ts
    if (inputComps && inputComps.scheme !== "file") {
      return undefined;
    }
    const [server, ...parts] = key.slice(2).split("/");
    return joinPathsToUri(`file://${server}/`, parts.join("/"));
  }
  return joinPathsToUri(URI.resolve(rootUri, "/"), key);
}

/*
  Returns just the file or folder name of a URI
*/
export function getUriPathBasename(uri: string): string {
  const path = getCleanUriPath(uri);
  const basename = path.split("/").pop() || "";
  return decodeURIComponent(basename);
}

export function getFileExtensionFromBasename(basename: string) {
  const parts = basename.split(".");
  if (parts.length < 2) {
    return "";
  }
  return (parts.slice(-1)[0] ?? "").toLowerCase();
}

/*
  Returns the file extension of a URI
*/
export function getUriFileExtension(uri: string) {
  const baseName = getUriPathBasename(uri);
  return getFileExtensionFromBasename(baseName);
}

export function getLastNUriRelativePathParts(
  dirUriCandidates: string[],
  uri: string,
  n: number,
): string {
  const { relativePathOrBasename } = findUriInDirs(uri, dirUriCandidates);
  return getLastNPathParts(relativePathOrBasename, n);
}

export function joinPathsToUri(uri: string, ...pathSegments: string[]) {
  let baseUri = uri;
  if (baseUri.at(-1) !== "/") {
    baseUri += "/";
  }
  const segments = pathSegments.map((segment) => pathToUriPathSegment(segment));
  return URI.resolve(baseUri, segments.join("/"));
}

export function joinEncodedUriPathSegmentToUri(
  uri: string,
  pathSegment: string,
) {
  let baseUri = uri;
  if (baseUri.at(-1) !== "/") {
    baseUri += "/";
  }
  return URI.resolve(baseUri, pathSegment);
}

export function getShortestUniqueRelativeUriPaths(
  uris: string[],
  dirUriCandidates: string[],
): {
  uri: string;
  uniquePath: string;
}[] {
  // Split all URIs into segments and count occurrences of each suffix combination
  const segmentCombinationsMap = new Map<string, number>();
  const segmentsInfo = uris.map((uri) => {
    const { relativePathOrBasename } = findUriInDirs(uri, dirUriCandidates);
    const segments = relativePathOrBasename.split("/");
    const suffixes: string[] = [];

    // Generate all possible suffix combinations, starting from the shortest (basename)
    for (let i = segments.length - 1; i >= 0; i--) {
      const suffix = segments.slice(i).join("/");
      suffixes.push(suffix); // Now pushing in order from shortest to longest
      // Count occurrences of each suffix
      segmentCombinationsMap.set(
        suffix,
        (segmentCombinationsMap.get(suffix) || 0) + 1,
      );
    }

    return { uri, segments, suffixes, relativePathOrBasename };
  });
  // Find shortest unique path for each URI
  return segmentsInfo.map(({ uri, suffixes, relativePathOrBasename }) => {
    // Since suffixes are now ordered from shortest to longest,
    // the first unique one we find will be the shortest
    const uniquePath =
      suffixes.find((suffix) => segmentCombinationsMap.get(suffix) === 1) ??
      relativePathOrBasename; // fallback to full path if no unique suffix found
    return { uri, uniquePath };
  });
}

// Only used when working with system paths and relative paths
// Since doesn't account for URI segements before workspace
export function getLastNPathParts(filepath: string, n: number): string {
  if (n <= 0) {
    return "";
  }
  return filepath.split(/[\\/]/).slice(-n).join("/");
}

export function getUriDescription(uri: string, dirUriCandidates: string[]) {
  const { relativePathOrBasename, foundInDir } = findUriInDirs(
    uri,
    dirUriCandidates,
  );
  const baseName = getUriPathBasename(uri);
  const extension = getFileExtensionFromBasename(baseName);
  const last2Parts = getLastNUriRelativePathParts(dirUriCandidates, uri, 2);
  return {
    uri,
    relativePathOrBasename,
    foundInDir,
    last2Parts,
    baseName,
    extension,
  };
}
