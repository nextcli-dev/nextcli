import * as vscode from "vscode";

function toUri(filepath: string): vscode.Uri {
  return filepath.includes("://")
    ? vscode.Uri.parse(filepath)
    : vscode.Uri.file(filepath);
}

/**
 * Keeps open editors in step with turn snapshots, which read and write the
 * files on disk.
 *
 * - "save": the agent's accepted edits can sit unsaved in an editor that
 *   isn't visible; save them so the end-of-turn snapshot sees them.
 * - "reload": after an undo, VS Code reloads clean editors by itself. Put
 *   the restored text into dirty ones too, so a later save doesn't write the
 *   undone content back.
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
      // The undo deleted the file; leave the editor as VS Code shows it.
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
