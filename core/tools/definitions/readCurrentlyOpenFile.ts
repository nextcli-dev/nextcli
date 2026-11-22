import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import { ResolvedPath, resolveInputPath } from "../../util/pathResolver";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";
import { evaluateFileAccessPolicy } from "../policies/fileAccess";

export const readCurrentlyOpenFileTool: Tool = {
  type: "function",
  displayTitle: "Read Currently Open File",
  wouldLikeTo: "read the current file",
  isCurrently: "reading the current file",
  hasAlready: "read the current file",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.ReadCurrentlyOpenFile,
    description:
      "Read the currently open file in the IDE. If the user seems to be referring to a file that you can't see, or is requesting an action on content that seems missing, try using this tool.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  // Like read_file: automatic for a file in the workspace, asks for one
  // outside it (see evaluateToolCallPolicy)
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To view the user's currently open file, use the ${BuiltInToolNames.ReadCurrentlyOpenFile} tool.
If the user is asking about a file and you don't see any code, use this to check the current file`,
  },
  toolCallIcon: "DocumentTextIcon",
  // The tool takes no path, so the policy looks at the file open now
  preprocessArgs: async (_args, { ide }) => {
    const currentFile = await ide.getCurrentFile();
    return {
      hasCurrentFile: !!currentFile,
      // An unsaved buffer isn't a project file: it counts as outside
      resolvedPath:
        currentFile && !currentFile.isUntitled
          ? await resolveInputPath(ide, currentFile.path)
          : null,
    };
  },
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    _: Record<string, unknown>,
    processedArgs?: Record<string, unknown>,
  ): ToolPolicy => {
    // No file open: the tool only says so
    if (processedArgs?.hasCurrentFile === false) return basePolicy;
    // Not preprocessed, or a path that didn't resolve, counts as outside
    const resolvedPath = processedArgs?.resolvedPath as
      | ResolvedPath
      | null
      | undefined;
    return evaluateFileAccessPolicy(
      basePolicy,
      !!resolvedPath?.isWithinWorkspace,
    );
  },
};
