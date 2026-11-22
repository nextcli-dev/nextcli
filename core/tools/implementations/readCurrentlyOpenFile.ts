import { getUriDescription } from "../../util/uri";

import { ToolImpl } from ".";
import { throwIfFileIsSecurityConcern } from "../../indexing/ignore";
import { resolveInputPath } from "../../util/pathResolver";
import { BuiltInToolNames } from "../builtIn";
import { throwIfFileExceedsHalfOfContext } from "./readFileLimit";

/**
 * Reads the open file only when it is a saved file in the workspace. The
 * check is on the same getCurrentFile() result that is returned, so the
 * file read is the file checked. For any other file the model gets its
 * path, to read it with read_file, which asks first and names the path.
 */
export const readCurrentlyOpenFileImpl: ToolImpl = async (_, extras) => {
  const result = await extras.ide.getCurrentFile();

  if (result) {
    throwIfFileIsSecurityConcern(result.path);
    if (result.isUntitled) {
      return [
        {
          name: "Current file not read",
          description: "Unsaved file",
          content:
            "The open file is unsaved, so it wasn't read. Ask the user to save it in the workspace or paste the part you need.",
        },
      ];
    }
    const resolved = await resolveInputPath(extras.ide, result.path);
    if (!resolved?.isWithinWorkspace) {
      const path = resolved?.displayPath ?? result.path;
      return [
        {
          name: "Current file not read",
          description: path,
          content: `The open file, ${path}, is outside the workspace, so it wasn't read. To read it, use the ${BuiltInToolNames.ReadFile} tool with that path; the user is asked first.`,
        },
      ];
    }
    await throwIfFileExceedsHalfOfContext(
      result.path,
      result.contents,
      extras.config.selectedModelByRole.chat,
    );

    const { relativePathOrBasename, last2Parts, baseName } = getUriDescription(
      result.path,
      await extras.ide.getWorkspaceDirs(),
    );

    return [
      {
        name: `Current file: ${baseName}`,
        description: last2Parts,
        content: `\`\`\`${relativePathOrBasename}\n${result.contents}\n\`\`\``,
        uri: {
          type: "file",
          value: result.path,
        },
      },
    ];
  } else {
    return [
      {
        name: `No Current File`,
        description: "",
        content: "There are no files currently open.",
      },
    ];
  }
};
