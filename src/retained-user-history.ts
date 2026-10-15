import type { ResponsesItem } from "./responses-projection.ts";

export type RetainedUserMessage = ResponsesItem & {
  role: "user";
  content: ResponsesItem[];
};

export function isRetainedUserMessage(value: unknown): value is RetainedUserMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.role === "user" &&
    (item.type === undefined || item.type === "message") &&
    Object.keys(item).every((key) => ["type", "role", "content"].includes(key)) &&
    Array.isArray(item.content) &&
    item.content.length > 0 &&
    item.content.every((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return false;
      if (part.type === "input_text") {
        return (
          typeof part.text === "string" &&
          Object.keys(part).every((key) => ["type", "text"].includes(key))
        );
      }
      return (
        part.type === "input_image" &&
        typeof part.image_url === "string" &&
        /^data:[^;,]+;base64,/.test(part.image_url) &&
        part.detail === "auto" &&
        Object.keys(part).every((key) => ["type", "image_url", "detail"].includes(key))
      );
    })
  );
}

// Codex e89b7c442c0433ad5167e72a5a25bb6d0712766a:
// compact_remote_v2.rs, compact_remote_v2_images.rs, context_manager/history.rs,
// and utils/string/src/truncate.rs. Pi emits inline images with detail=auto;
// Codex charges ceil(7373 / 4) tokens for those, not their base64 byte length.
const RETAINED_USER_TOKEN_BUDGET = 64_000;
const AUTO_IMAGE_TOKENS = 1_844;

function contentTokens(part: ResponsesItem): number {
  return part.type === "input_image"
    ? AUTO_IMAGE_TOKENS
    : Math.ceil(Buffer.byteLength(part.text as string, "utf8") / 4);
}

function truncateText(text: string, tokens: number): string {
  const bytes = Buffer.from(text, "utf8");
  const budget = tokens * 4;
  if (bytes.length <= budget) return text;
  let left = Math.floor(budget / 2);
  let right = bytes.length - (budget - left);
  while (left > 0 && (bytes[left]! & 0xc0) === 0x80) left--;
  while (right < bytes.length && (bytes[right]! & 0xc0) === 0x80) right++;
  // Upstream's notice is outside the retained-text budget.
  return (
    bytes.toString("utf8", 0, left) +
    `…${Math.ceil((bytes.length - budget) / 4)} tokens truncated…` +
    bytes.toString("utf8", right)
  );
}

function truncateBoundary(
  item: RetainedUserMessage,
  remaining: number,
): RetainedUserMessage | undefined {
  const hasImages = item.content.some((part) => part.type === "input_image");
  const parts = hasImages ? [...item.content].reverse() : item.content;
  const content: ResponsesItem[] = [];
  for (const part of parts) {
    if (remaining === 0) break;
    const cost = contentTokens(part);
    if (cost <= remaining) {
      if (part.type !== "input_text" || part.text !== "") content.push(part);
      remaining -= cost;
    } else {
      if (part.type === "input_text")
        content.push({ ...part, text: truncateText(part.text as string, remaining) });
      remaining = 0;
    }
  }
  if (hasImages) content.reverse();
  return content.length ? { ...item, content } : undefined;
}

export function retainUserHistory(items: readonly RetainedUserMessage[]): RetainedUserMessage[] {
  let remaining = RETAINED_USER_TOKEN_BUDGET;
  const retained: RetainedUserMessage[] = [];
  for (let i = items.length - 1; i >= 0 && remaining > 0; i--) {
    const item = items[i]!;
    const cost = Math.max(
      1,
      item.content.reduce((sum, part) => sum + contentTokens(part), 0),
    );
    if (cost <= remaining) {
      retained.push(item);
      remaining -= cost;
    } else {
      const boundary = truncateBoundary(item, remaining);
      if (boundary) retained.push(boundary);
      // In particular, never backfill older users after an oversized image.
      break;
    }
  }
  return retained.reverse();
}
