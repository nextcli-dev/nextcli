// A tiny OpenAI-compatible server for `run.mjs --mock`: it checks the whole
// pipeline without a provider or a key. It is not a model. It reads the three
// logs one by one, then the first again (so the context grows, a compaction
// happens and a file is re-read after it), writes a
// canned summary when asked to compact, and answers every recall probe with a
// canned reply. Its step counter lives here, not in the history, so a
// compaction does not make it start over; the runner resets it before each
// run. The script reads task 5's logs: smoke-test with --tasks 5.
import http from "node:http";

const SUMMARY_MARKER = "concise summary of our conversation";
const PROBE_MARKER = "Answer from memory";
const CANNED_SUMMARY =
  "Summary: read logs/app-1.log and logs/app-2.log. Still to read: logs/app-3.log.";
const CANNED_PROBE = "I do not remember.";
const CANNED_DONE = "Finished reading the logs.";

function sse(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const chunk = (delta, finish, usage) => ({
  id: "mock",
  object: "chat.completion.chunk",
  created: 0,
  model: "mock-model",
  choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  ...(usage && { usage }),
});

export async function startMockServer() {
  let step = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const request = JSON.parse(body);
      const text = JSON.stringify(request.messages);
      const last = String(
        request.messages.findLast((m) => m.role === "user")?.content ?? "",
      );
      const usage = {
        prompt_tokens: Math.ceil(text.length / 4),
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 0 },
      };
      const say = (content) =>
        sse(
          res,
          [
            chunk({ role: "assistant", content }),
            chunk({}, "stop"),
            chunk({}, null, usage),
          ].map((c, i) => (i === 2 ? { ...c, choices: [] } : c)),
        );
      if (last.includes(SUMMARY_MARKER)) {
        return say(CANNED_SUMMARY);
      }
      if (last.includes(PROBE_MARKER)) {
        return say(CANNED_PROBE);
      }
      step += 1;
      if (step > 4) {
        return say(CANNED_DONE);
      }
      const call = {
        index: 0,
        id: `call_${step}`,
        type: "function",
        function: {
          name: "Read",
          arguments: JSON.stringify({
            filepath: `logs/app-${step === 4 ? 1 : step}.log`,
          }),
        },
      };
      sse(res, [
        chunk({ role: "assistant", tool_calls: [call] }),
        chunk({}, "tool_calls"),
        { ...chunk({}, null, usage), choices: [] },
      ]);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Starts the script over, for the next run */
    reset: () => {
      step = 0;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
