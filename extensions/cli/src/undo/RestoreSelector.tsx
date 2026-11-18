import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";

import type { ChatHistoryItem } from "../../../../core/index.js";
import { services } from "../services/index.js";
import { defaultBoxStyles } from "../ui/styles.js";
import { formatError } from "../util/formatError.js";

import type { UndoPlan } from "./SnapshotService.js";
import type { RestoreMode } from "./turnSnapshot.js";

const MAX_FILES_SHOWN = 12;

const CHOICES: { mode: RestoreMode | "cancel"; label: string }[] = [
  { mode: "code-and-conversation", label: "Restore code and conversation" },
  { mode: "code", label: "Restore code only" },
  { mode: "cancel", label: "Cancel" },
];

interface RestoreSelectorProps {
  chatHistory: ChatHistoryItem[];
  /** History index of the first user message to undo. */
  fromIndex: number;
  onConfirm: (plan: UndoPlan, mode: RestoreMode) => void;
  onCancel: () => void;
}

function FileList({
  label,
  files,
  color,
}: {
  label: string;
  files: string[];
  color: string;
}) {
  if (files.length === 0) return null;
  const shown = files.slice(0, MAX_FILES_SHOWN);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color}>
        {label} ({files.length}):
      </Text>
      {shown.map((file) => (
        <Text key={file}> {file}</Text>
      ))}
      {files.length > shown.length && (
        <Text color="gray"> …and {files.length - shown.length} more</Text>
      )}
    </Box>
  );
}

/**
 * Shows what undoing the turns from a message would change, then asks
 * whether to restore code and conversation, or code only.
 */
export function RestoreSelector({
  chatHistory,
  fromIndex,
  onConfirm,
  onCancel,
}: RestoreSelectorProps) {
  const [plan, setPlan] = useState<UndoPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let cancelled = false;
    services.snapshot
      .planUndo(chatHistory, fromIndex)
      .then((result) => {
        if (!cancelled) setPlan(result);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => {
      cancelled = true;
    };
    // The plan is for the history as it was when the screen opened.
  }, []);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }
    if (!plan) return;
    if (key.upArrow || input === "k") {
      setSelected((prev) => (prev > 0 ? prev - 1 : CHOICES.length - 1));
    } else if (key.downArrow || input === "j") {
      setSelected((prev) => (prev < CHOICES.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      const choice = CHOICES[selected];
      if (choice.mode === "cancel") onCancel();
      else onConfirm(plan, choice.mode);
    }
  });

  const content = chatHistory[fromIndex]?.message.content;
  const preview =
    typeof content === "string" ? content.split("\n")[0].slice(0, 60) : "";

  if (error) {
    return (
      <Box {...defaultBoxStyles("red")}>
        <Text color="red">Can't undo: {error}</Text>
        <Text color="gray">Press Esc to go back</Text>
      </Box>
    );
  }

  if (!plan) {
    return (
      <Box {...defaultBoxStyles("yellow")}>
        <Text color="gray">Working out what to restore…</Text>
      </Box>
    );
  }

  const nothing = plan.plan.restore.length + plan.plan.delete.length === 0;

  return (
    <Box {...defaultBoxStyles("yellow")}>
      <Text color="yellow" bold>
        Undo {plan.turns === 1 ? "turn" : `${plan.turns} turns`} from: {preview}
      </Text>
      <Text color="gray">↑/↓ to choose, Enter to confirm, Esc to cancel</Text>
      {nothing && (
        <Box marginTop={1}>
          <Text>These turns changed no files.</Text>
        </Box>
      )}
      <FileList label="Put back" files={plan.plan.restore} color="green" />
      <FileList
        label="Delete (created by the agent)"
        files={plan.plan.delete}
        color="red"
      />
      <FileList
        label="Changed since the agent wrote them, will be overwritten"
        files={plan.plan.conflicts}
        color="yellow"
      />
      <Box flexDirection="column" marginTop={1}>
        {CHOICES.map((choice, index) => (
          <Text
            key={choice.mode}
            bold={index === selected}
            color={index === selected ? "yellow" : "white"}
          >
            {index === selected ? "➤ " : "  "}
            {choice.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
