import type { Reasoning, ReasoningDetail } from "core/index.js";

/**
 * Merges streamed `reasoning_details` deltas. An item merges into the item
 * with the same `type` and `index`, so separate thinking blocks (each with its
 * own signature) stay separate, and a reasoning item's summary and encrypted
 * content (same index, different types) stay separate too.
 * Text-like fields are concatenated; other fields are overwritten.
 */
export function mergeReasoningDetailDeltas(
  existing: ReasoningDetail[] | undefined,
  delta: ReasoningDetail[],
): ReasoningDetail[] {
  const result = existing ? [...existing] : [];
  for (const item of delta) {
    if (!item || typeof item !== "object") continue;
    const matchIndex = result.findIndex((current) =>
      current.type === item.type &&
      (item.index === undefined
        ? current.index === undefined
        : current.index === item.index),
    );
    if (matchIndex === -1) {
      result.push({ ...item });
      continue;
    }
    const merged = { ...result[matchIndex] };
    for (const [key, value] of Object.entries(item)) {
      if (value === null || value === undefined) continue;
      if (
        (key === "text" || key === "signature" || key === "summary") &&
        typeof value === "string"
      ) {
        merged[key] = ((merged[key] as string | undefined) ?? "") + value;
      } else if (key !== "type" || merged.type === undefined) {
        merged[key] = value;
      }
    }
    result[matchIndex] = merged;
  }
  return result;
}

/**
 * Collects the reasoning a model streams alongside its reply:
 * `reasoning_content` (DeepSeek, Kimi, many gateways), a string `reasoning`
 * (OpenRouter), and `reasoning_details` (OpenRouter, and the Anthropic and
 * OpenAI Responses adapters). The text field the server used is remembered so
 * the reasoning can be sent back in the same field.
 */
export class ReasoningAccumulator {
  private text = "";
  private textField?: Reasoning["textField"];
  private details?: ReasoningDetail[];
  private startAt?: number;

  add(delta: unknown): void {
    if (!delta || typeof delta !== "object") return;
    const { reasoning_content, reasoning, reasoning_details } = delta as {
      reasoning_content?: unknown;
      reasoning?: unknown;
      reasoning_details?: unknown;
    };

    if (typeof reasoning_content === "string" && reasoning_content) {
      this.appendText(reasoning_content, "reasoning_content");
    } else if (typeof reasoning === "string" && reasoning) {
      this.appendText(reasoning, "reasoning");
    }

    if (Array.isArray(reasoning_details) && reasoning_details.length > 0) {
      this.startAt ??= Date.now();
      this.details = mergeReasoningDetailDeltas(
        this.details,
        reasoning_details as ReasoningDetail[],
      );
    }
  }

  result(): Reasoning | undefined {
    if (!this.text && !this.details?.length) return undefined;
    return {
      active: false,
      text: this.text,
      startAt: this.startAt ?? Date.now(),
      endAt: Date.now(),
      ...(this.textField && { textField: this.textField }),
      ...(this.details?.length && { details: this.details }),
    };
  }

  private appendText(text: string, field: NonNullable<Reasoning["textField"]>) {
    this.startAt ??= Date.now();
    this.textField ??= field;
    this.text += text;
  }
}
