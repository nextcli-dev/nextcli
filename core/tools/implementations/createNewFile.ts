import { ToolImpl } from ".";
import { throwIfFileIsSecurityConcern } from "../../indexing/ignore";
import { ContinueError, ContinueErrorReason } from "../../util/errors";
import { resolveNewFilePath } from "../../util/pathResolver";
import { getCleanUriPath, getUriPathBasename } from "../../util/uri";
import { getStringArg } from "../parseArgs";

export const createNewFileImpl: ToolImpl = async (args, extras) => {
  const filepath = getStringArg(args, "filepath");
  const contents = getStringArg(args, "contents", true);

  // The file the permission check judged (createNewFileTool.preprocessArgs):
  // a file outside the workspace has already asked the user
  const { uri, isWithinWorkspace } = await resolveNewFilePath(
    extras.ide,
    filepath,
  );
  throwIfFileIsSecurityConcern(getCleanUriPath(uri));
  if (await extras.ide.fileExists(uri)) {
    throw new ContinueError(
      ContinueErrorReason.FileAlreadyExists,
      `File ${filepath} already exists. Use the edit tool to edit this file`,
    );
  }
  await extras.ide.writeFile(uri, contents);
  await extras.ide.openFile(uri);
  await extras.ide.saveFile(uri);
  if (isWithinWorkspace) {
    void extras.codeBaseIndexer?.refreshCodebaseIndexFiles([uri]);
  }
  return [
    {
      name: getUriPathBasename(uri),
      description: getCleanUriPath(uri),
      content: "File created successfuly",
      uri: {
        type: "file",
        value: uri,
      },
    },
  ];
};
