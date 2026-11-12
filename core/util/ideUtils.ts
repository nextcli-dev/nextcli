import { IDE } from "..";

import {
  findLocalPathInDirs,
  hasUriScheme,
  isAbsoluteLocalPath,
  isSameLocalPath,
  joinEncodedUriPathSegmentToUri,
  joinPathsToUri,
  localPathEndsWith,
  localPathToUri,
  pathToUriPathSegment,
} from "./uri";

/*
  Resolves the path an edit tool was given to the URI of an existing file:
  a workspace-relative path (with "/" or "\"), an absolute path (C:\...,
  \\server\share\..., /...) or a URI, the forms the read tools accept.
  A file outside the workspace folders resolves too, by an absolute path or
  by "..": handleApplyStateUpdate never auto-accepts an edit to it.
  Never returns a workspace folder itself (fileExists is true for folders).
*/
export async function resolveEditableFileUri(
  filepath: string,
  ide: IDE,
): Promise<string | undefined> {
  const path = filepath.trim();
  const workspaceDirs = await ide.getWorkspaceDirs();
  let openFiles: string[] | undefined;
  const getOpenFiles = async () => (openFiles ??= await ide.getOpenFiles());
  const isWorkspaceFolder = (uri: string) =>
    findLocalPathInDirs(uri, workspaceDirs)?.relativePath === "";

  if (hasUriScheme(path) || isAbsoluteLocalPath(path)) {
    const match = findLocalPathInDirs(path, workspaceDirs);
    if (match?.relativePath) {
      const uri = joinPathsToUri(match.dirUri, match.relativePath);
      if (await ide.fileExists(uri)) {
        return uri;
      }
    }
    const openFile = (await getOpenFiles()).find((uri) =>
      isSameLocalPath(uri, path),
    );
    if (openFile) {
      return openFile;
    }
    // A POSIX path such as /src/a.ts usually means "relative to the
    // workspace", so that reading comes before the filesystem root
    if (path.startsWith("/") && !path.startsWith("//")) {
      const workspaceUri = await resolveRelativePathInDir(
        path,
        ide,
        workspaceDirs,
      );
      if (workspaceUri && !isWorkspaceFolder(workspaceUri)) {
        return workspaceUri;
      }
    }
    const uri = localPathToUri(path, workspaceDirs);
    if (uri && !isWorkspaceFolder(uri) && (await ide.fileExists(uri))) {
      return uri;
    }
    return undefined;
  }

  const relativeUri = await resolveRelativePathInDir(path, ide, workspaceDirs);
  if (relativeUri && !isWorkspaceFolder(relativeUri)) {
    return relativeUri;
  }

  // The model sometimes gives only the last parts of an open file's path
  return (await getOpenFiles()).find((uri) => localPathEndsWith(uri, path));
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
  if (activeFile && localPathEndsWith(activeFile.path, relativePath)) {
    return activeFile.path;
  }

  // If no unique match found, use the first directory
  return joinPathsToUri(dirs[0], relativePath);
}
