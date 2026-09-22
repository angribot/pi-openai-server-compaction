import { convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  getSystemMessageText,
  normalizeContext,
  renderSystemMessageUpdate,
  resolveTranscript,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";

export type ResponsesItem = Record<string, unknown> & { type?: string };

/**
 * Projection controls mirroring the subset of Pi's Responses conversion this
 * extension owns. The production extension loader cannot resolve Pi's Responses
 * converter subpath, so the narrow projection is retained locally.
 */
export type CompactableContextOptions = {
  /**
   * Emit the leading system message as a provider input item. Remote compaction
   * keeps effective instructions in the top-level request field, so its input
   * omits the leading system message; later system updates remain in place.
   */
  includeSystemPrompt: boolean;
  /**
   * True when this projection continues Responses items that precede it, such as
   * replacement history. A system message at the start is then a mid-conversation
   * update rather than the leading prompt.
   */
  hasPrecedingItems?: boolean;
};

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function normalizeIdPart(part: string): string {
  return part
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64)
    .replace(/_+$/, "");
}

function shortHash(value: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const character = value.charCodeAt(index);
    first = Math.imul(first ^ character, 2654435761);
    second = Math.imul(second ^ character, 1597334677);
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (second >>> 0).toString(36) + (first >>> 0).toString(36);
}

function normalizeToolCallId(id: string, source: AssistantMessage, model: Model<any>): string {
  if (!OPENAI_TOOL_CALL_PROVIDERS.has(model.provider)) return normalizeIdPart(id);
  if (!id.includes("|")) return normalizeIdPart(id);

  const [callId = "", itemId = ""] = id.split("|");
  const normalizedCallId = normalizeIdPart(callId);
  const isForeign = source.provider !== model.provider || source.api !== model.api;
  let normalizedItemId = isForeign ? `fc_${shortHash(itemId)}` : normalizeIdPart(itemId);
  if (!normalizedItemId.startsWith("fc_")) {
    normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
  }
  return `${normalizedCallId}|${normalizedItemId}`;
}

function parseTextSignature(value: unknown): { id?: string; phase?: string } | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!value.startsWith("{")) return { id: value };

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.v === 1 && typeof parsed.id === "string") {
      return {
        id: parsed.id,
        ...(parsed.phase === "commentary" || parsed.phase === "final_answer"
          ? { phase: parsed.phase }
          : {}),
      };
    }
  } catch {
    // Pi treats malformed brace-prefixed signatures as legacy literal IDs.
  }
  return { id: value };
}

function replaceImagesWithPlaceholder(
  content: readonly (TextContent | ImageContent)[],
  placeholder: string,
): (TextContent | ImageContent)[] {
  const result: (TextContent | ImageContent)[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

// Mirrors Pi 0.87 `transformMessages` (`openai-responses-shared` reuses it):
// null-content normalization, image downgrade, foreign thinking/tool
// normalization, and synthetic missing tool results. System messages that land
// between a tool call and its results are held back until after those results.
function normalizeMessages(messages: readonly Message[], model: Model<any>): Message[] {
  const toolCallIdMap = new Map<string, string>();
  const normalizedMessages = messages.map((message) =>
    message.content == null ? ({ ...message, content: [] } as Message) : message,
  );
  const imageAwareMessages = model.input.includes("image")
    ? normalizedMessages
    : normalizedMessages.map((message): Message => {
        if (message.role === "user" && Array.isArray(message.content)) {
          return {
            ...message,
            content: replaceImagesWithPlaceholder(
              message.content,
              NON_VISION_USER_IMAGE_PLACEHOLDER,
            ),
          };
        }
        if (message.role === "toolResult") {
          return {
            ...message,
            content: replaceImagesWithPlaceholder(
              message.content,
              NON_VISION_TOOL_IMAGE_PLACEHOLDER,
            ),
          };
        }
        return message;
      });

  const transformed = imageAwareMessages.map((message): Message => {
    if (message.role === "system" || message.role === "user") return message;
    if (message.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(message.toolCallId);
      return normalizedId && normalizedId !== message.toolCallId
        ? { ...message, toolCallId: normalizedId }
        : message;
    }

    const isSameModel =
      message.provider === model.provider &&
      message.api === model.api &&
      message.model === model.id;
    const content = message.content.flatMap(
      (block): (TextContent | ThinkingContent | ToolCall)[] => {
        if (block.type === "thinking") {
          if (block.redacted) return isSameModel ? [block] : [];
          if (isSameModel && block.thinkingSignature) return [block];
          if (!block.thinking || block.thinking.trim() === "") return [];
          return isSameModel ? [block] : [{ type: "text", text: block.thinking }];
        }
        if (block.type === "text") {
          return [isSameModel ? block : { type: "text", text: block.text }];
        }
        if (block.type === "toolCall") {
          let normalized: ToolCall = block;
          if (!isSameModel && block.thoughtSignature) {
            normalized = { ...block };
            delete normalized.thoughtSignature;
          }
          if (!isSameModel) {
            const normalizedId = normalizeToolCallId(block.id, message, model);
            if (normalizedId !== block.id) {
              toolCallIdMap.set(block.id, normalizedId);
              normalized = { ...normalized, id: normalizedId };
            }
          }
          return [normalized];
        }
        return [block];
      },
    );
    return { ...message, content };
  });

  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  const heldSystemMessages: Message[] = [];

  const closePendingToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      for (const toolCall of pendingToolCalls) {
        if (existingToolResultIds.has(toolCall.id)) continue;
        result.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: Date.now(),
        });
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
    result.push(...heldSystemMessages);
    heldSystemMessages.length = 0;
  };

  for (const message of transformed) {
    if (message.role === "assistant") {
      closePendingToolCalls();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const toolCalls = message.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(message);
      continue;
    }
    if (message.role === "toolResult") {
      existingToolResultIds.add(message.toolCallId);
      result.push(message);
      continue;
    }
    if (message.role === "system") {
      if (pendingToolCalls.length > 0) heldSystemMessages.push(message);
      else result.push(message);
      continue;
    }
    if (message.role === "user") {
      closePendingToolCalls();
      result.push(message);
      continue;
    }
    result.push(message);
  }
  closePendingToolCalls();
  return result;
}

function userContent(content: string | readonly (TextContent | ImageContent)[]): ResponsesItem[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: sanitizeSurrogates(content) }];
  }
  return content.map((block) => {
    if (block.type === "text") {
      return { type: "input_text", text: sanitizeSurrogates(block.text) };
    }
    return {
      type: "input_image",
      detail: "auto",
      image_url: `data:${block.mimeType};base64,${block.data}`,
    };
  });
}

function toolResultOutput(
  model: Model<any>,
  content: readonly (TextContent | ImageContent)[],
): string | ResponsesItem[] {
  const textResult = content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const images = content.filter((block): block is ImageContent => block.type === "image");
  const hasText = textResult.length > 0;
  if (images.length === 0 || !model.input.includes("image")) {
    return sanitizeSurrogates(
      hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)",
    );
  }
  const output: ResponsesItem[] = [];
  if (hasText) output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
  for (const image of images) {
    output.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  return output;
}

// Mirrors Pi 0.87 `convertResponsesMessages` for the tool-free Remote compaction
// subset: message/function-call items, Pi fallback IDs and phases, foreign
// item-id normalization, function-call outputs, and API-specific leading-system
// placement. It intentionally never emits tool declarations.
function projectNormalizedMessages(
  messages: readonly Message[],
  model: Model<any>,
  options: CompactableContextOptions,
): ResponsesItem[] {
  const projected: ResponsesItem[] = [];
  const supportsDeveloperRole =
    (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole !==
    false;
  const instructionRole = model.reasoning && supportsDeveloperRole ? "developer" : "system";
  let messageIndex = 0;
  let sourceIndex = 0;

  for (const message of messages) {
    const isFirstMessage = sourceIndex++ === 0;
    const isLeadingSystemMessage =
      !options.hasPrecedingItems && isFirstMessage && message.role === "system";
    if (message.role === "system") {
      if (!isLeadingSystemMessage || options.includeSystemPrompt) {
        const text = isLeadingSystemMessage
          ? getSystemMessageText(message)
          : renderSystemMessageUpdate(message);
        if (text.length > 0) {
          projected.push({ role: instructionRole, content: sanitizeSurrogates(text) });
        }
      }
    } else if (message.role === "user") {
      const content = userContent(message.content);
      if (Array.isArray(message.content) && content.length === 0) continue;
      projected.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const isSameProviderAndApi = message.provider === model.provider && message.api === model.api;
      const isSameModel = isSameProviderAndApi && message.model === model.id;
      const isDifferentModel = isSameProviderAndApi && message.model !== model.id;
      const output: ResponsesItem[] = [];
      let textBlockIndex = 0;

      for (const block of message.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature) as ResponsesItem);
          }
          continue;
        }
        if (block.type === "text") {
          const signature = parseTextSignature(block.textSignature);
          const fallbackId =
            textBlockIndex === 0
              ? `msg_pi_${messageIndex}`
              : `msg_pi_${messageIndex}_${textBlockIndex}`;
          textBlockIndex++;
          let id = signature?.id || fallbackId;
          if (id.length > 64) id = `msg_${shortHash(id)}`;
          output.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeSurrogates(block.text),
                annotations: [],
              },
            ],
            status: "completed",
            id,
            ...(signature?.phase ? { phase: signature.phase } : {}),
          });
          continue;
        }
        if (block.type === "toolCall") {
          const [callId, rawItemId] = block.id.split("|");
          let itemId: string | undefined = rawItemId;
          if (!itemId?.startsWith("fc_") || isDifferentModel) {
            itemId = undefined;
          }
          output.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
            ...(isSameModel && block.namespace !== undefined ? { namespace: block.namespace } : {}),
          });
        }
      }
      if (output.length === 0) continue;
      projected.push(...output);
    } else {
      const [callId] = message.toolCallId.split("|");
      projected.push({
        type: "function_call_output",
        call_id: callId,
        output: toolResultOutput(model, message.content),
      });
    }
    if (!isLeadingSystemMessage) messageIndex++;
  }

  return projected;
}

export function projectCompactableContext(
  messages: readonly AgentMessage[],
  model: Model<any>,
  options: CompactableContextOptions = { includeSystemPrompt: true },
): ResponsesItem[] {
  const supportsMidConvoSystemMessages =
    (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)
      ?.supportsMidConvoSystemMessages ?? false;
  const resolved = resolveTranscript(
    normalizeContext({ messages: convertToLlm([...messages]) }),
    supportsMidConvoSystemMessages,
  );
  return projectNormalizedMessages(normalizeMessages(resolved.messages, model), model, options);
}
