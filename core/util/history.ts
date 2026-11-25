import * as fs from "fs";

import { forgetJournal, syncJournal } from "@nextcli/context/archive";

import { BaseSessionMetadata, Session } from "../index.js";
import { ListHistoryOptions } from "../protocol/core.js";

import { NEW_SESSION_TITLE } from "./constants.js";
import {
  getSessionFilePath,
  getSessionJournalPath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths.js";
function safeParseArray<T>(
  value: string,
  errorMessage: string = "Error parsing array",
): T[] | undefined {
  try {
    return JSON.parse(value) as T[];
  } catch (e: any) {
    console.warn(`${errorMessage}: ${e}`);
    return undefined;
  }
}

/**
 * The history without each model call's prompt. The prompt is the whole
 * conversation again, so earlier versions' sessions held hundreds of MB of
 * them. Both load and save drop it: cn --resume and /import read session
 * files without load. A file can hold anything, so entries that aren't
 * objects stay as they are: a throw here would load the session empty. A
 * history that isn't an array becomes an empty one, as callers spread it.
 */
function withoutPrompts(history: Session["history"]): Session["history"] {
  if (!Array.isArray(history)) {
    return [];
  }
  return history.map((item) =>
    Array.isArray(item?.promptLogs)
      ? {
          ...item,
          promptLogs: item.promptLogs.map((log) => {
            if (!log || typeof log !== "object") {
              return log;
            }
            const { prompt, ...rest } = log;
            return rest;
          }),
        }
      : item,
  );
}

let warnedTranscript = false;

/**
 * Appends what changed to the session's transcript, which keeps every turn:
 * compaction and undo shorten the session file, never the transcript. A
 * failure is reported once and never stops the save.
 */
function writeTranscript(
  session: Session,
  history: Session["history"],
  sessionFile: string,
) {
  const journal = getSessionJournalPath(session.sessionId);
  if (!journal) {
    return;
  }
  try {
    syncJournal(journal, history, {
      sessionFile,
      workspace: session.workspaceDirectory,
    });
  } catch (e) {
    if (!warnedTranscript) {
      warnedTranscript = true;
      console.warn(`Couldn't write the session transcript ${journal}: ${e}`);
    }
  }
}

export class HistoryManager {
  list(options: ListHistoryOptions): BaseSessionMetadata[] {
    const filepath = getSessionsListPath();
    if (!fs.existsSync(filepath)) {
      return [];
    }
    const content = fs.readFileSync(filepath, "utf8");

    let sessions = safeParseArray<BaseSessionMetadata>(content) ?? [];
    sessions = sessions
      .filter((session: any) => {
        // Filter out old format
        return typeof session.session_id !== "string";
        // Reverse to show newest first; sessions.json is chronological by creation
      })
      .reverse();

    // Filter by workspace directory if provided
    if (options.workspaceDirectory) {
      const target = options.workspaceDirectory.toLowerCase();
      sessions = sessions.filter(
        (session) =>
          typeof session.workspaceDirectory === "string" &&
          session.workspaceDirectory.toLowerCase() === target,
      );
    }

    // Apply limit and offset
    if (options.limit) {
      const offset = options.offset || 0;
      sessions = sessions.slice(offset, offset + options.limit);
    }

    return sessions;
  }

  delete(sessionId: string) {
    // The transcript first: the check below throws if the file is gone
    const journal = getSessionJournalPath(sessionId);
    if (journal) {
      forgetJournal(journal);
      fs.rmSync(journal, { force: true });
    }

    // Delete a session
    const sessionFile = getSessionFilePath(sessionId);
    if (!fs.existsSync(sessionFile)) {
      throw new Error(`Session file ${sessionFile} does not exist`);
    }
    fs.unlinkSync(sessionFile);

    // Read and update the sessions list
    const sessionsListFile = getSessionsListPath();
    const sessionsListRaw = fs.readFileSync(sessionsListFile, "utf-8");
    let sessionsList =
      safeParseArray<BaseSessionMetadata>(
        sessionsListRaw,
        "Error parsing sessions.json",
      ) ?? [];

    sessionsList = sessionsList.filter(
      (session) => session.sessionId !== sessionId,
    );

    fs.writeFileSync(
      sessionsListFile,
      JSON.stringify(sessionsList, undefined, 2),
    );
  }

  clearAll() {
    forgetJournal();
    fs.rmSync(getSessionsFolderPath(), { recursive: true, force: true });
  }

  load(sessionId: string): Session {
    try {
      const sessionFile = getSessionFilePath(sessionId);
      if (!fs.existsSync(sessionFile)) {
        throw new Error(`Session file ${sessionFile} does not exist`);
      }
      const session: Session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      session.sessionId = sessionId;
      session.history = withoutPrompts(session.history);
      return session;
    } catch (e) {
      console.log(`Error loading session: ${e}`);
      return {
        history: [],
        title: NEW_SESSION_TITLE,
        workspaceDirectory: "",
        sessionId: sessionId,
      };
    }
  }

  save(session: Session) {
    // Save the main session json file
    // Explicitely rewriting here to influence the written key order in the file!
    // e.g. id at the top, history next, etc.
    const orderedSession: Session = {
      sessionId: session.sessionId,
      title: session.title,
      workspaceDirectory: session.workspaceDirectory,
      history: withoutPrompts(session.history),
    };
    if (session.mode) {
      orderedSession.mode = session.mode;
    }
    if (session.chatModelTitle !== undefined) {
      orderedSession.chatModelTitle = session.chatModelTitle;
    }
    if (session.usage !== undefined) {
      orderedSession.usage = session.usage;
    }

    const sessionFile = getSessionFilePath(session.sessionId);
    // Before the file is written: a session saved before the transcript
    // existed has its earlier turns only there
    writeTranscript(session, orderedSession.history, sessionFile);
    fs.writeFileSync(sessionFile, JSON.stringify(orderedSession, undefined, 2));

    // Read and update the sessions list
    const sessionsListFilePath = getSessionsListPath();
    try {
      const rawSessionsList = fs.readFileSync(sessionsListFilePath, "utf-8");

      let sessionsList: BaseSessionMetadata[];
      try {
        sessionsList = JSON.parse(rawSessionsList);
      } catch (e) {
        if (rawSessionsList.trim() === "") {
          fs.writeFileSync(sessionsListFilePath, JSON.stringify([]));
          sessionsList = [];
        } else {
          throw e;
        }
      }

      let found = false;
      const messageCount = session.history.filter(
        (item) => item.message.role === "assistant",
      ).length;
      for (const sessionMetadata of sessionsList) {
        if (sessionMetadata.sessionId === session.sessionId) {
          sessionMetadata.title = session.title;
          sessionMetadata.workspaceDirectory = session.workspaceDirectory;
          sessionMetadata.messageCount = messageCount;
          found = true;
          break;
        }
      }

      if (!found) {
        const sessionMetadata: BaseSessionMetadata = {
          sessionId: session.sessionId,
          title: session.title,
          dateCreated: String(Date.now()),
          workspaceDirectory: session.workspaceDirectory,
          messageCount,
        };
        sessionsList.push(sessionMetadata);
      }

      fs.writeFileSync(
        sessionsListFilePath,
        JSON.stringify(sessionsList, undefined, 2),
      );
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `It looks like there is a JSON formatting error in your sessions.json file (${sessionsListFilePath}). Please fix this before creating a new session.`,
        );
      }
      throw new Error(
        `It looks like there is a validation error in your sessions.json file (${sessionsListFilePath}). Please fix this before creating a new session. Error: ${error}`,
      );
    }
  }
}

const historyManager = new HistoryManager();

export default historyManager;
