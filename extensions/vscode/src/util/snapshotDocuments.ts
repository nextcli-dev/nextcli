import * as vscode from "vscode";

function toUri(filepath: string): vscode.Uri {
  return filepath.includes("://")
    ? vscode.Uri.parse(filepath)
    : vscode.Uri.file(filepath);
}

/**
 * "save": accepted edits can sit unsaved in a hidden editor. "reload": VS Code
 * reloads clean editors itself; dirty ones would save the undone text back.
 */
export async function syncSnapshotDocuments(
  filepaths: readonly string[],
  action: "save" | "reload",
): Promise<void> {
  const targets = new Set(filepaths.map((f) => toUri(f).toString()));
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || !targets.has(document.uri.toString())) {
      continue;
    }
    if (action === "save") {
      await document.save();
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(document.uri),
      );
    } catch {
      continue;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      ),
      text,
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }
}
