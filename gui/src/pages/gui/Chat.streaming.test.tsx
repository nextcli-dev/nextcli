import { act, screen } from "@testing-library/react";
import type { ChatHistoryItem } from "core";
import { useCallback, useRef } from "react";
import {
  newSession,
  setActive,
  setInactive,
  streamUpdate,
} from "../../redux/slices/sessionSlice";
import { renderWithProviders } from "../../util/test/render";
import { Chat } from "./Chat";

// Counts, per markdown block (keyed by the source it parsed), how often it
// renders and how often it re-parses. Every StyledMarkdownPreview calls
// useRemark once per render.
const renders = new Map<string, number>();
const parses: string[] = [];

vi.mock("react-remark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-remark")>();
  return {
    ...actual,
    useRemark: (options: Parameters<typeof actual.useRemark>[0]) => {
      const [content, setSource] = actual.useRemark(options);
      const source = useRef<string | undefined>(undefined);
      if (source.current !== undefined) {
        renders.set(source.current, (renders.get(source.current) ?? 0) + 1);
      }
      const set = useCallback(
        (value: string) => {
          source.current = value;
          parses.push(value);
          setSource(value);
        },
        [setSource],
      );
      return [content, set] as const;
    },
  };
});

const PAST_TURNS = 12;
const CHUNKS = 200;
const STREAMING_PREFIX = "STREAMING";

function item(
  role: "user" | "assistant" | "thinking",
  content: string,
): ChatHistoryItem & { message: { id: string } } {
  return {
    message: { role, content, id: `${role}-${content.slice(0, 24)}` } as any,
    contextItems: [],
  };
}

function pastHistory() {
  const history = [];
  for (let i = 0; i < PAST_TURNS; i++) {
    history.push(item("user", `Question ${i}`));
    history.push(item("thinking", `Past reasoning ${i} about the question.`));
    history.push(
      item(
        "assistant",
        `Past answer ${i}.\n\n\`\`\`ts\nconst value${i} = ${i};\n\`\`\`\n\nDone ${i}.`,
      ),
    );
  }
  history.push(item("user", "Stream a long answer"));
  history.push(item("assistant", STREAMING_PREFIX));
  return history;
}

const pastRenders = () =>
  [...renders]
    .filter(([source]) => !source.startsWith(STREAMING_PREFIX))
    .reduce((sum, [, count]) => sum + count, 0);

test("streaming a reply re-renders neither past messages nor every chunk", async () => {
  const { store } = await renderWithProviders(<Chat />);
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "streaming-test",
        title: "Streaming",
        workspaceDirectory: "",
        history: pastHistory(),
      }),
    );
    store.dispatch(setActive());
  });

  // Let the past messages render and parse once
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  renders.clear();
  parses.length = 0;

  for (let i = 0; i < CHUNKS; i++) {
    await act(async () => {
      store.dispatch(
        streamUpdate([
          {
            role: "assistant",
            content: ` word${i}`,
          },
        ]),
      );
    });
  }
  await act(async () => {
    store.dispatch(setInactive());
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  // Past messages don't change, so they don't render again
  expect(pastRenders()).toBe(0);

  // The streaming message parses far fewer times than it gets chunks, and
  // its final text is parsed
  const streamingParses = parses.filter((s) => s.startsWith(STREAMING_PREFIX));
  expect(streamingParses.length).toBeLessThan(CHUNKS / 4);
  expect(streamingParses.at(-1)).toContain(`word${CHUNKS - 1}`);
}, 30_000);

test("uses history positions when the history holds a system message", async () => {
  const { store } = await renderWithProviders(<Chat />);
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "system-test",
        title: "System",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "system", content: "rules", id: "system-0" },
            contextItems: [],
          } as any,
          item("user", "Think about it"),
          item("thinking", "Reasoning so far"),
        ],
      }),
    );
    store.dispatch(setActive());
  });

  // The last item is the thinking block, so it is in progress and capped
  expect(screen.getByTestId("thinking-block-live")).toHaveTextContent(
    "Reasoning so far",
  );
});
