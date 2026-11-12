import { IDE } from "..";

import {
  findLocalPathInDirs,
  hasUriScheme,
  isAbsoluteLocalPath,
  isSameLocalPath,
  joinEncodedUriPathSegmentToUri,
  joinPathsToUri,
  localPathEndsWith,
  pathToUriPathSegment,
} from "./uri";

/*
  Resolves the path an edit tool was given to the URI of an existing file.
  Accepts the forms the read tools accept: a workspace-relative path (with
  "/" or "\"), an absolute path (C:\..., \\server\share\..., /...) or a
  file:// URI. An absolute path must be inside a workspace folder or name an
  open file, so the edit tools reach the same files as before, by any path form.
*/
export async function resolveEditableFileUri(
  filepath: string,
  ide: IDE,
): Promise<string | undefined> {
  let path = filepath.trim();
  if (path.startsWith("./") || path.startsWith(".\\")) {
    path = path.slice(2);
  }

  const isAbsolute = hasUriScheme(path) || isAbsoluteLocalPath(path);
  if (isAbsolute) {
    const match = findLocalPathInDirs(path, await ide.getWorkspaceDirs());
    if (match) {
      const uri = joinPathsToUri(match.dirUri, match.relativePath);
      if (await ide.fileExists(uri)) {
        return uri;
      }
    }
    const openFile = (await ide.getOpenFiles()).find((uri) =>
      isSameLocalPath(uri, path),
    );
    if (openFile) {
      return openFile;
    }
    // A POSIX path such as /src/a.ts may still mean "relative to the
    // workspace"; that was the only reading before absolute paths worked
    if (!path.startsWith("/")) {
      return undefined;
    }
  }

  const relativeMatch = await resolveRelativePathInDir(path, ide);
  if (relativeMatch) {
    return relativeMatch;
  }

  // The model sometimes gives only the last parts of an open file's path
  return (await ide.getOpenFiles()).find((uri) => localPathEndsWith(uri, path));
}

/*
  This function takes a relative (to workspace) filepath
  And checks each workspace for if it exists or not
  Only returns fully resolved URI if it exists
*/
export async function resolveRelativePathInDir(
  path: string,
  ide: IDE,
  dirUriCandidates?: string[],
): Promise<string | undefined> {
  const dirs = dirUriCandidates ?? (await ide.getWorkspaceDirs());
  for (const dirUri of dirs) {
    const fullUri = joinPathsToUri(dirUri, path);
    if (await ide.fileExists(fullUri)) {
      return fullUri;
    }
  }

  return undefined;
}

/*
  Same as above but in this case the relative path does not need to exist (e.g. file to be created, etc)
  Checks closes match with the dirs, path segment by segment
  and based on which workspace has the closest matching path, returns resolved URI
  If no meaninful path match just concatenates to first dir's uri
*/
export async function inferResolvedUriFromRelativePath(
  _relativePath: string,
  ide: IDE,
  dirCandidates?: string[],
): Promise<string> {
  const relativePath = _relativePath.trim().replaceAll("\\", "/");
  const dirs = dirCandidates ?? (await ide.getWorkspaceDirs());

  if (dirs.length === 0) {
    throw new Error("inferResolvedUriFromRelativePath: no dirs provided");
  }

  const segments = pathToUriPathSegment(relativePath).split("/");
  // Generate all possible suffixes from shortest to longest
  const suffixes: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    suffixes.push(segments.slice(i).join("/"));
  }

  // For each suffix, try to find a unique matching dir/file
  for (const suffix of suffixes) {
    const uris = dirs.map((dir) => ({
      dir,
      partialUri: joinEncodedUriPathSegmentToUri(dir, suffix),
    }));
    const promises = uris.map(async ({ partialUri, dir }) => {
      const exists = await ide.fileExists(partialUri);
      return {
        dir,
        partialUri,
        exists,
      };
    });
    const existenceChecks = await Promise.all(promises);

    const existingUris = existenceChecks.filter(({ exists }) => exists);

    // If exactly one directory matches, use it
    if (existingUris.length === 1) {
      return joinEncodedUriPathSegmentToUri(
        existingUris[0].dir,
        segments.join("/"),
      );
    }
  }

  // Sometimes the model will decide to only output the base name or small number of path parts
  // in which case we shouldn't create a new file if it matches the current file
  const activeFile = await ide.getCurrentFile();
  if (activeFile && activeFile.path.endsWith(relativePath)) {
    return activeFile.path;
  }

  // If no unique match found, use the first directory
  return joinPathsToUri(dirs[0], relativePath);
}
