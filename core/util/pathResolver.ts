import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "path";
import untildify from "untildify";
import { IDE } from "..";
import { ContinueError, ContinueErrorReason } from "./errors";
import {
  inferResolvedUriFromRelativePath,
  resolveRelativePathInDir,
} from "./ideUtils";
import {
  findLocalPathInDirs,
  hasUriScheme,
  isAbsoluteLocalPath,
  joinPathsToUri,
  localPathToUri,
} from "./uri";

export interface ResolvedPath {
  uri: string;
  displayPath: string;
  isAbsolute: boolean;
  isWithinWorkspace: boolean;
}

/**
 * Checks if a URI is within any of the workspace directories
 * Also verifies the file actually exists, matching the behavior of resolveRelativePathInDir
 */
async function isUriWithinWorkspace(ide: IDE, uri: string): Promise<boolean> {
  const workspaceDirs = await ide.getWorkspaceDirs();
  // Compare decoded paths: pathToFileURL gives file:///C:/proj/a.ts, while
  // VS Code's workspace folders look like file:///c%3A/proj
  // Check both: within workspace path AND file exists
  return findLocalPathInDirs(uri, workspaceDirs)
    ? await ide.fileExists(uri)
    : false;
}

export async function resolveInputPath(
  ide: IDE,
  inputPath: string,
): Promise<ResolvedPath | null> {
  const trimmedPath = inputPath.trim();

  // Handle file:// URIs
  if (trimmedPath.startsWith("file://")) {
    const displayPath = fileURLToPath(trimmedPath);
    const isWithinWorkspace = await isUriWithinWorkspace(ide, trimmedPath);
    return {
      uri: trimmedPath,
      displayPath,
      isAbsolute: true,
      isWithinWorkspace,
    };
  }

  // Expand tilde paths (handles ~/ and ~username/)
  const expandedPath = untildify(trimmedPath);

  // Check if it's an absolute path (including Windows paths)
  const isAbsolute =
    path.isAbsolute(expandedPath) ||
    // Windows network paths
    expandedPath.startsWith("\\\\") ||
    // Windows drive letters
    /^[a-zA-Z]:/.test(expandedPath);

  if (isAbsolute) {
    // Convert to file:// URI format
    const uri = pathToFileURL(expandedPath).href;
    const isWithinWorkspace = await isUriWithinWorkspace(ide, uri);
    return {
      uri,
      displayPath: expandedPath,
      isAbsolute: true,
      isWithinWorkspace,
    };
  }

  // Handle relative paths...
  const workspaceDirs = await ide.getWorkspaceDirs();
  const workspaceUri = await resolveRelativePathInDir(
    expandedPath,
    ide,
    workspaceDirs,
  );
  if (workspaceUri) {
    return {
      uri: workspaceUri,
      displayPath: expandedPath,
      isAbsolute: false,
      // ".." can climb out of the workspace folders
      isWithinWorkspace:
        findLocalPathInDirs(workspaceUri, workspaceDirs) !== undefined,
    };
  }

  return null;
}

/**
 * Resolves where create_new_file writes a file that doesn't exist yet. Its
 * permission check and its write both call this, so the user approves the
 * file that gets written.
 * - A relative path goes in the workspace, as before, and may climb out with "..".
 * - An absolute path, a ~ path or a URI is created where it points. A path
 *   such as /src/a.ts usually means "relative to the workspace", so it is
 *   only absolute when its top folder (/tmp) exists on disk and not in the
 *   workspace.
 * isWithinWorkspace is decided on the resulting URI.
 */
export async function resolveNewFilePath(
  ide: IDE,
  inputPath: string,
): Promise<ResolvedPath> {
  const trimmedPath = inputPath.trim();
  const workspaceDirs = await ide.getWorkspaceDirs();
  const isUri = hasUriScheme(trimmedPath);
  const expandedPath = isUri ? trimmedPath : untildify(trimmedPath);

  let uri: string | undefined;
  let isAbsolute = false;
  if (isUri || isAbsoluteLocalPath(expandedPath)) {
    const match = findLocalPathInDirs(expandedPath, workspaceDirs);
    if (match && !match.relativePath) {
      throw new ContinueError(
        ContinueErrorReason.PathResolutionFailed,
        `${trimmedPath} is a workspace folder, not a file`,
      );
    }
    if (match) {
      uri = joinPathsToUri(match.dirUri, match.relativePath);
      isAbsolute = true;
    } else if (!(await isWorkspaceRootPath(ide, trimmedPath, workspaceDirs))) {
      uri = localPathToUri(expandedPath, workspaceDirs);
      if (!uri) {
        throw new ContinueError(
          ContinueErrorReason.PathResolutionFailed,
          `Can't create ${trimmedPath}: use a file path, or a file:// URI`,
        );
      }
      isAbsolute = true;
    }
  }
  uri ??= await inferResolvedUriFromRelativePath(
    expandedPath,
    ide,
    workspaceDirs,
  );

  return {
    uri,
    displayPath: trimmedPath,
    isAbsolute,
    isWithinWorkspace: !!findLocalPathInDirs(uri, workspaceDirs)?.relativePath,
  };
}

/**
 * Whether a path the model wrote as /src/a.ts means "relative to the
 * workspace": its top folder is in a workspace folder, or isn't at the
 * filesystem root
 */
async function isWorkspaceRootPath(
  ide: IDE,
  inputPath: string,
  workspaceDirs: string[],
): Promise<boolean> {
  if (
    !inputPath.startsWith("/") ||
    inputPath.startsWith("//") ||
    workspaceDirs.length === 0
  ) {
    return false;
  }
  const topFolder = inputPath.split(/[\\/]/).find(Boolean);
  if (!topFolder) {
    return false;
  }
  const inWorkspace = await Promise.all(
    workspaceDirs.map((dir) => ide.fileExists(joinPathsToUri(dir, topFolder))),
  );
  if (inWorkspace.some(Boolean)) {
    return true;
  }
  const atRoot = localPathToUri(`/${topFolder}`, workspaceDirs);
  return !atRoot || !(await ide.fileExists(atRoot));
}
