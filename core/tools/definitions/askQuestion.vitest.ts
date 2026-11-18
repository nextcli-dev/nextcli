import { describe, expect, it } from "vitest";

import { IDE } from "../..";
import { CLIENT_TOOLS_IMPLS } from "../builtIn";
import { handleToolCallBuffer } from "../systemMessageTools/toolCodeblocks/parseSystemToolCall";
import { getInitialToolCallParseState } from "../systemMessageTools/types";
import { askQuestionTool } from "./askQuestion";

const extras = { ide: {} as IDE };

/**
 * Feeds a system-message tool call to the parser the way the stream does: the
 * opening fence with its newline, then each line and each newline alone.
 */
function parseSystemToolCall(text: string): Record<string, unknown> {
  const state = getInitialToolCallParseState();
  const [fence, ...lines] = text.split("\n");
  const chunks = [`${fence}\n`, ...lines.flatMap((line) => [line, "\n"])];
  let args = "";
  for (const chunk of chunks) {
    const delta = handleToolCallBuffer(chunk, state);
    args += delta?.function?.arguments ?? "";
    if (state.done) break;
  }
  return JSON.parse(args);
}

describe("askQuestionTool", () => {
  it("runs in the webview, needs no approval and is offered in plan mode", () => {
    expect(CLIENT_TOOLS_IMPLS).toContain(askQuestionTool.function.name);
    expect(askQuestionTool.defaultToolPolicy).toBe("allowedWithoutPermission");
    expect(askQuestionTool.readonly).toBe(true);
    // A tool call icon would send the call to SimpleToolCallUI instead of the
    // question renderer.
    expect(askQuestionTool.toolCallIcon).toBeUndefined();
  });

  it("returns the normalized questions from preprocessArgs", async () => {
    await expect(
      askQuestionTool.preprocessArgs!(
        {
          questions: [
            { header: "Which database?", options: ["Postgres", "Other"] },
          ],
        },
        extras,
      ),
    ).resolves.toEqual({
      questions: [
        {
          question: "Which database?",
          options: [{ label: "Postgres" }],
          multiSelect: false,
        },
      ],
    });
  });

  it("rejects arguments the panel cannot show, with a message for the model", async () => {
    await expect(askQuestionTool.preprocessArgs!({}, extras)).rejects.toThrow(
      /Pass at least one question.*Fix the arguments and call the tool again\./,
    );
  });

  it("parses its own system-message example into questions", async () => {
    const [[name, value]] =
      askQuestionTool.systemMessageDescription!.exampleArgs!;
    const call = [
      "```tool",
      `TOOL_NAME: ${askQuestionTool.function.name}`,
      `BEGIN_ARG: ${name}`,
      String(value),
      "END_ARG",
      "```",
    ].join("\n");

    const args = parseSystemToolCall(call);
    expect(Array.isArray(args.questions)).toBe(true);

    const set = await askQuestionTool.preprocessArgs!(args, extras);
    expect(set).toMatchObject({
      questions: [
        { header: "Database", multiSelect: false },
        { header: "Auth", multiSelect: true },
      ],
    });
  });
});
