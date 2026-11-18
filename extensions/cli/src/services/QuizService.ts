import { EventEmitter } from "events";

import type { AnswerSet, QuestionSet } from "@nextcli/ask-question";

import { ToolInterruptedError } from "../tools/toolInterruptedError.js";

export interface PendingQuestion {
  requestId: string;
  set: QuestionSet;
}

/** Emitted when the terminal UI should show `set`. */
export type QuestionRequestedEvent = PendingQuestion;

/** Emitted when a question set is answered, dismissed or abandoned. */
export interface QuestionAnsweredEvent {
  requestId: string;
}

export interface QuizServiceState {
  pendingQuestion: PendingQuestion | null;
}

/**
 * Hands AskQuestion's questions to the terminal UI and waits for the answers.
 * One question set is shown at a time: parallel AskQuestion calls wait their
 * turn instead of replacing each other on screen.
 */
export class QuizService extends EventEmitter {
  private pending = new Map<string, (answers: AnswerSet) => void>();
  private nextId = 0;
  private queue: Promise<unknown> = Promise.resolve();

  private currentState: QuizServiceState = {
    pendingQuestion: null,
  };

  /**
   * Whether anything can answer a question. Only the terminal UI listens;
   * cn -p and cn serve have nobody to ask.
   */
  canAskQuestions(): boolean {
    return this.listenerCount("questionRequested") > 0;
  }

  /**
   * Shows `set` once earlier question sets are done and resolves with the
   * answers. Rejects with ToolInterruptedError when `signal` aborts first.
   */
  askQuestions(set: QuestionSet, signal?: AbortSignal): Promise<AnswerSet> {
    // Without a listener the promise below would never settle: cn -p would
    // exit with no output, and a cn serve turn would hang.
    if (!this.canAskQuestions()) {
      return Promise.reject(
        new Error(
          "Nobody can answer questions in this run. Continue without asking, and state the assumptions you make.",
        ),
      );
    }
    const turn = this.queue.then(() => this.show(set, signal));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private show(set: QuestionSet, signal?: AbortSignal): Promise<AnswerSet> {
    if (signal?.aborted) return Promise.reject(new ToolInterruptedError());
    const requestId = `quiz-${++this.nextId}`;

    return new Promise<AnswerSet>((resolve, reject) => {
      const onAbort = () => {
        this.settle(requestId);
        reject(new ToolInterruptedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, (answers) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(answers);
      });
      this.currentState.pendingQuestion = { requestId, set };
      const event: QuestionRequestedEvent = { requestId, set };
      this.emit("questionRequested", event);
    });
  }

  /** Forgets a request and tells the UI to close its prompt. */
  private settle(requestId: string): boolean {
    if (!this.pending.delete(requestId)) return false;
    if (this.currentState.pendingQuestion?.requestId === requestId) {
      this.currentState.pendingQuestion = null;
    }
    const event: QuestionAnsweredEvent = { requestId };
    this.emit("questionAnswered", event);
    return true;
  }

  /** Answers (or dismisses) a pending request. False if it is not pending. */
  answerQuestions(requestId: string, answers: AnswerSet): boolean {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    this.settle(requestId);
    resolve(answers);
    return true;
  }

  async initialize(): Promise<QuizServiceState> {
    this.currentState = {
      pendingQuestion: null,
    };
    this.pending.clear();
    this.queue = Promise.resolve();
    return this.currentState;
  }
}

export const quizService = new QuizService();
