import ignore from "ignore";
import type { FileType, IDE } from "../";
import { findUriInDirs, getUriPathBasename } from "../util/uri";
import { getGlobalContinueIgArray } from "./continueignore";
import { defaultIgnoreFileAndDir } from "./ignore";
import { getIgnoreContext } from "./walkDir";

/*
    Process:
    1. Check global/default ignores
    2. Walk UP tree from file, checking ignores at each level

    TODO there might be issues with symlinks here
*/
export async function shouldIgnore(
  fileUri: string,
  ide: IDE,
  rootDirCandidates?: string[],
): Promise<boolean> {
  const rootDirUris = rootDirCandidates ?? (await ide.getWorkspaceDirs());
  const {
    foundInDir: rootDir,
    uri,
    relativePathOrBasename,
  } = findUriInDirs(fileUri, rootDirUris);

  if (!rootDir) {
    return true;
  }
  if (relativePathOrBasename === "") {
    // The root itself
    return false;
  }

  const defaultAndGlobalIgnores = ignore()
    .add(defaultIgnoreFileAndDir)
    .add(getGlobalContinueIgArray());

  // Climb one parent per part of the path relative to the root, so the walk
  // stops at the root however its uri is written (adt://sys, file:///proj/)
  const relativeParts = relativePathOrBasename.split("/");
  const uriSegments = uri.replace(/\/$/, "").split("/");
  let directParent = true;
  let fileType = 1 as FileType.File as FileType;
  for (let levelsUp = 1; levelsUp <= relativeParts.length; levelsUp++) {
    const currentDir =
      levelsUp === relativeParts.length
        ? rootDir
        : uriSegments.slice(0, uriSegments.length - levelsUp).join("/");

    // Get all files in the dir. A directory that can't be listed (e.g. on a
    // virtual filesystem) contributes no ignore files instead of failing
    let dirEntries: [string, FileType][] = [];
    try {
      dirEntries = await ide.listDir(currentDir);
    } catch (e) {
      console.warn(
        `Could not list ${currentDir} while checking ignores: ${e instanceof Error ? e.message : e}`,
      );
    }

    // Check if the file is a symbolic link, ignore if so
    if (directParent) {
      directParent = false;
      const baseName = getUriPathBasename(fileUri);
      const entry = dirEntries.find(([name, _]) => name === baseName);
      if (entry) {
        fileType = entry[1];
        if (fileType === (64 as FileType.SymbolicLink)) {
          return true;
        }
      }
    }

    const ignoreContext = await getIgnoreContext(
      currentDir,
      dirEntries,
      ide,
      defaultAndGlobalIgnores,
    ).catch(() => defaultAndGlobalIgnores);

    let relativePath = relativeParts
      .slice(relativeParts.length - levelsUp)
      .join("/");
    if (fileType === (2 as FileType.Directory)) {
      relativePath += "/";
    }

    if (ignoreContext.ignores(relativePath)) {
      return true;
    }
  }

  return false;
}
