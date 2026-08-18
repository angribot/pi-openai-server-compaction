import { convertToLlm, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export type ResponsesItem = Record<string, unknown> & { type?: string };

export type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
};

export class UnrepresentableCompactableContextError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnrepresentableCompactableContextError";
  }
}

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const SUPPORTED_AGENT_MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "custom",
  "bashExecution",
  "branchSummary",
  "compactionSummary",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, cause?: unknown): never {
  throw new UnrepresentableCompactableContextError(
    `Unrepresentable compactable context: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

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

function normalizeToolCallId(
  id: string,
  source: Record<string, unknown>,
  model: Model<any>,
): string {
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

function assertSupportedAgentMessages(messages: readonly AgentMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (!isRecord(message) || !SUPPORTED_AGENT_MESSAGE_ROLES.has(String(message.role))) {
      fail(`message ${index} has an unknown model-facing role`);
    }
  }
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

function replaceImagesWithPlaceholder(content: readonly unknown[], placeholder: string): unknown[] {
  const result: unknown[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (!isRecord(block)) fail("message content contains a non-object block");
    if (block.type === "image") {
      if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.type === "text" && block.text === placeholder;
  }
  return result;
}

function normalizeMessages(
  messages: readonly Message[],
  model: Model<any>,
): Record<string, unknown>[] {
  const toolCallIdMap = new Map<string, string>();
  const supportsImages = model.input.includes("image");
  const imageAware: Record<string, unknown>[] = messages.map((source) => {
    const message = source as unknown as Record<string, unknown>;
    const content = message.content == null ? [] : message.content;
    if (supportsImages) return { ...message, content };
    if (message.role === "user" && Array.isArray(content)) {
      return {
        ...message,
        content: replaceImagesWithPlaceholder(content, NON_VISION_USER_IMAGE_PLACEHOLDER),
      };
    }
    if (message.role === "toolResult" && Array.isArray(content)) {
      return {
        ...message,
        content: replaceImagesWithPlaceholder(content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
      };
    }
    return { ...message, content };
  });

  const transformed = imageAware.map((message, messageIndex) => {
    if (message.role === "user") return message;
    if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !message.toolCallId) {
        fail(`tool result ${messageIndex} has no call identity`);
      }
      const normalizedId = toolCallIdMap.get(message.toolCallId);
      return normalizedId ? { ...message, toolCallId: normalizedId } : message;
    }
    if (message.role !== "assistant") {
      const role = message.role;
      fail(`normalized message ${messageIndex} has unknown role ${String(role)}`);
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return { ...message, content: [] };
    }
    if (!Array.isArray(message.content))
      fail(`assistant message ${messageIndex} has invalid content`);

    const isSameModel =
      message.provider === model.provider &&
      message.api === model.api &&
      message.model === model.id;
    const blocks = message.content as unknown[];
    const content: unknown[] = blocks.flatMap((value, blockIndex): unknown[] => {
      if (!isRecord(value)) {
        fail(`assistant message ${messageIndex} block ${blockIndex} is invalid`);
      }
      const block = value;
      if (block.type === "thinking") {
        if (typeof block.thinking !== "string") {
          fail(`assistant reasoning block ${blockIndex} is malformed`);
        }
        if (block.redacted === true) return isSameModel ? [block] : [];
        if (isSameModel && typeof block.thinkingSignature === "string" && block.thinkingSignature) {
          return [block];
        }
        if (!block.thinking.trim()) return [];
        return isSameModel ? [block] : [{ type: "text", text: block.thinking }];
      }
      if (block.type === "text") {
        if (typeof block.text !== "string") fail(`assistant text block ${blockIndex} is malformed`);
        return [isSameModel ? block : { type: "text", text: block.text }];
      }
      if (block.type === "toolCall") {
        if (
          typeof block.id !== "string" ||
          !block.id.split("|")[0] ||
          typeof block.name !== "string" ||
          !block.name
        ) {
          fail(`assistant tool call ${blockIndex} is malformed`);
        }
        if (isSameModel) return [block];
        const normalizedId = normalizeToolCallId(block.id, message, model);
        toolCallIdMap.set(block.id, normalizedId);
        const normalized: Record<string, unknown> = { ...block, id: normalizedId };
        delete normalized.thoughtSignature;
        return [normalized];
      }
      return fail(
        `assistant message ${messageIndex} has unknown content type ${String(block.type)}`,
      );
    });
    return { ...message, content };
  });

  const result: Record<string, unknown>[] = [];
  let pendingToolCalls: Record<string, unknown>[] = [];
  let resultIds = new Set<string>();

  const flushMissingResults = () => {
    for (const call of pendingToolCalls) {
      const id = String(call.id);
      if (resultIds.has(id)) continue;
      result.push({
        role: "toolResult",
        toolCallId: id,
        toolName: call.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
      });
    }
    pendingToolCalls = [];
    resultIds = new Set();
  };

  for (const [messageIndex, message] of transformed.entries()) {
    if (message.role === "assistant") {
      flushMissingResults();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const calls = (message.content as Record<string, unknown>[]).filter(
        (block) => block.type === "toolCall",
      );
      const seen = new Set<string>();
      for (const call of calls) {
        const id = String(call.id);
        if (seen.has(id)) fail(`assistant message ${messageIndex} repeats tool call ${id}`);
        seen.add(id);
      }
      pendingToolCalls = calls;
      result.push(message);
      continue;
    }
    if (message.role === "toolResult") {
      const toolCallId = String(message.toolCallId);
      const matchingCall = pendingToolCalls.find((call) => call.id === toolCallId);
      if (!matchingCall || matchingCall.name !== message.toolName || resultIds.has(toolCallId)) {
        fail(`tool result ${messageIndex} has no unique matching function call`);
      }
      resultIds.add(toolCallId);
      result.push(message);
      continue;
    }
    if (message.role === "user") {
      flushMissingResults();
      result.push(message);
      continue;
    }
    fail(`normalized message ${messageIndex} has unknown role`);
  }
  flushMissingResults();
  return result;
}

function userContent(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") {
    return [{ type: "input_text", text: sanitizeSurrogates(content) }];
  }
  if (!Array.isArray(content)) fail("user content is neither text nor a content array");
  return content.map((block, index) => {
    if (!isRecord(block)) fail(`user content block ${index} is invalid`);
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "input_text", text: sanitizeSurrogates(block.text) };
    }
    if (
      block.type === "image" &&
      typeof block.mimeType === "string" &&
      typeof block.data === "string"
    ) {
      return {
        type: "input_image",
        detail: "auto",
        image_url: `data:${block.mimeType};base64,${block.data}`,
      };
    }
    return fail(`user content block ${index} has unknown type ${String(block.type)}`);
  });
}

function toolResultOutput(model: Model<any>, content: unknown): string | Record<string, unknown>[] {
  if (!Array.isArray(content)) fail("tool result content is not an array");
  const texts: string[] = [];
  const images: Record<string, unknown>[] = [];
  for (const [index, block] of content.entries()) {
    if (!isRecord(block)) fail(`tool result block ${index} is invalid`);
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(sanitizeSurrogates(block.text));
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.mimeType === "string" &&
      typeof block.data === "string"
    ) {
      if (!model.input.includes("image")) {
        texts.push(NON_VISION_TOOL_IMAGE_PLACEHOLDER);
      } else {
        images.push({
          type: "input_image",
          detail: "auto",
          image_url: `data:${block.mimeType};base64,${block.data}`,
        });
      }
      continue;
    }
    fail(`tool result block ${index} has unknown type ${String(block.type)}`);
  }
  const text = texts.join("\n");
  if (images.length === 0) return text || "(no tool output)";
  return [...(text ? [{ type: "input_text", text }] : []), ...images];
}

function projectNormalizedMessages(
  messages: readonly Record<string, unknown>[],
  model: Model<any>,
): ResponsesItem[] {
  const projected: ResponsesItem[] = [];
  let messageIndex = 0;

  for (const message of messages) {
    if (message.role === "user") {
      const content = userContent(message.content);
      if (Array.isArray(message.content) && content.length === 0) continue;
      projected.push({ role: "user", content });
      messageIndex++;
      continue;
    }

    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) fail("assistant content is not an array");
      const isSameProviderAndApi = message.provider === model.provider && message.api === model.api;
      const isSameModel = isSameProviderAndApi && message.model === model.id;
      const isDifferentModel = isSameProviderAndApi && message.model !== model.id;
      const output: ResponsesItem[] = [];
      let textBlockIndex = 0;

      for (const [blockIndex, block] of message.content.entries()) {
        if (!isRecord(block)) fail(`assistant block ${blockIndex} is invalid`);
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            try {
              const reasoning = JSON.parse(String(block.thinkingSignature)) as unknown;
              if (!isRecord(reasoning) || reasoning.type !== "reasoning") {
                fail(`assistant reasoning block ${blockIndex} has an invalid signature item`);
              }
              output.push(reasoning as ResponsesItem);
            } catch (error) {
              if (error instanceof UnrepresentableCompactableContextError) throw error;
              fail(`assistant reasoning block ${blockIndex} has an invalid signature`, error);
            }
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
          let id = signature?.id ?? fallbackId;
          if (id.length > 64) id = `msg_${shortHash(id)}`;
          output.push({
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: sanitizeSurrogates(String(block.text)),
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
          const [callId, rawItemId] = String(block.id).split("|");
          if (!callId) fail(`assistant tool call ${blockIndex} has an empty call identity`);
          let itemId: string | undefined = rawItemId;
          if (!itemId?.startsWith("fc_") || isDifferentModel) {
            itemId = undefined;
          }
          let argumentsJson: string;
          try {
            argumentsJson = JSON.stringify(block.arguments);
          } catch (error) {
            fail(`assistant tool call ${blockIndex} arguments are not serializable`, error);
          }
          if (argumentsJson === undefined) {
            fail(`assistant tool call ${blockIndex} arguments are not serializable`);
          }
          output.push({
            type: "function_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: String(block.name),
            arguments: argumentsJson,
            ...(isSameModel && typeof block.namespace === "string"
              ? { namespace: block.namespace }
              : {}),
          });
        }
      }
      if (output.length === 0) continue;
      projected.push(...output);
      messageIndex++;
      continue;
    }

    if (message.role === "toolResult") {
      const [callId] = String(message.toolCallId).split("|");
      if (!callId) fail("tool result has an empty call identity");
      projected.push({
        type: "function_call_output",
        call_id: callId,
        output: toolResultOutput(model, message.content),
      });
      messageIndex++;
      continue;
    }

    fail(`normalized message has unknown role ${String(message.role)}`);
  }

  return projected;
}

export function projectCompactableContext(
  messages: readonly AgentMessage[],
  model: Model<any>,
): ResponsesItem[] {
  assertSupportedAgentMessages(messages);
  let normalized: Message[];
  try {
    normalized = convertToLlm([...messages]);
  } catch (error) {
    fail("Pi message normalization failed", error);
  }
  return projectNormalizedMessages(normalizeMessages(normalized, model), model);
}

export function projectActiveFunctionTools(
  allTools: readonly ToolInfo[],
  activeToolNames: readonly string[],
): ResponsesFunctionTool[] {
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  const activeTools: ResponsesFunctionTool[] = [];
  for (const name of activeToolNames) {
    const tool = byName.get(name);
    if (!tool) continue;
    activeTools.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
  }
  return activeTools;
}
