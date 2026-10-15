import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  getDeclaredTools,
  getSystemMessageText,
  normalizeContext,
  renderSystemMessageUpdate,
  resolveTranscript,
  resolveTranscriptTools,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type OpenAIResponsesCompat,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type Tool,
  type SystemMessage,
} from "@earendil-works/pi-ai";

import { projectJsonSchemaTool } from "./responses-tool-schema.ts";

export type ResponsesItem = Record<string, unknown> & { type?: string };
export type ProjectedContext = { input: ResponsesItem[]; tools: ResponsesItem[] };

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
  /**
   * Checkpoint-owned declarations inherited by a post-checkpoint suffix. Used
   * to project inherited active tools and classify historical call/result items.
   */
  checkpointSystemMessage?: SystemMessage;
  /** Current ordinary transcript's declaration environment, separate from the span being projected. */
  declarationMessages?: readonly AgentMessage[];
};

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

// Pi's extension loader cannot resolve api/constrained-sampling. Mirror its
// grammar selection after capability-dependent transcript resolution, including
// declarations needed by retained results whose calls precede the checkpoint.
function grammarDefinition(tool: Tool, model: Model<any>) {
  const config = tool.constrainedSampling;
  if (!config || config.type !== "grammar" ||
      !(model.compat as OpenAIResponsesCompat | undefined)?.supportsOpenAIGrammarTools) return undefined;
  const lark = config.variants.openai_lark;
  const regex = config.variants.openai_regex;
  const hasLark = typeof lark === "string" && lark.trim().length > 0;
  if (!hasLark && !(typeof regex === "string" && regex.trim().length > 0)) {
    throw new Error(`Tool "${tool.name}" has no supported grammar variant.`);
  }
  const schema = tool.parameters as {
    type?: unknown; required?: unknown; properties?: Record<string, { type?: unknown }>;
  };
  const required = schema.required;
  if (schema.type !== "object" || !Array.isArray(required) || required.length !== 1 ||
      typeof required[0] !== "string" || schema.properties?.[required[0]]?.type !== "string") {
    throw new Error(`Grammar tool "${tool.name}" requires exactly one required string parameter.`);
  }
  return { syntax: hasLark ? "lark" : "regex", definition: hasLark ? lark : regex, inputProperty: required[0] };
}

function grammarInputProperties(tools: readonly Tool[], model: Model<any>): Map<string, string> {
  const properties = new Map<string, string>();
  for (const tool of tools) {
    const grammar = grammarDefinition(tool, model);
    if (grammar) properties.set(tool.name, grammar.inputProperty);
  }
  return properties;
}

function grammarInput(call: ToolCall, property: string): string {
  const input = call.arguments[property];
  if (typeof input !== "string") {
    throw new Error(`Grammar tool call "${call.name}" requires argument "${property}" to be a string.`);
  }
  return sanitizeSurrogates(input);
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

// Mirrors Pi 0.99.1 `transformMessages` (`openai-responses-shared` reuses it):
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

// Mirrors Pi 1.2.0 `convertResponsesMessages` for Remote compaction:
// message/function/custom-tool items, Pi fallback IDs and phases, foreign
// item-id normalization, tool outputs, and API-specific leading-system
// placement, including model-supported in-place tool additions.
function projectNormalizedMessages(
  messages: readonly Message[],
  model: Model<any>,
  options: CompactableContextOptions,
  grammarToolInputProperties: ReadonlyMap<string, string>,
  anchorsAdditions: boolean,
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
      if (!isLeadingSystemMessage && anchorsAdditions && message.toolsAdded?.length) {
        const compat = model.compat as OpenAIResponsesCompat | undefined;
        if (compat?.supportsAdditionalTools) {
          projected.push({ type: "additional_tools", role: "developer",
            tools: projectToolDeclarations(message.toolsAdded, model) });
        } else if (compat?.supportsToolSearch) {
          const names = message.toolsAdded.map(tool => tool.name);
          const callId = `pi_tool_load_${shortHash(`system:${messageIndex}:${names.join(",")}`)}`;
          projected.push({ type: "tool_search_call", call_id: callId, execution: "client", status: "completed",
            arguments: { query: names.join(" "), limit: names.length } },
          { type: "tool_search_output", call_id: callId, execution: "client", status: "completed",
            tools: projectToolDeclarations(message.toolsAdded, model, true) });
        }
      }
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
          const inputProperty = grammarToolInputProperties.get(block.name);
          let itemId: string | undefined = rawItemId;
          const itemIdPrefix = inputProperty === undefined ? "fc_" : "ctc_";
          if (isDifferentModel || !itemId?.startsWith(itemIdPrefix)) {
            itemId = undefined;
          }
          output.push({
            type: inputProperty === undefined ? "function_call" : "custom_tool_call",
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            ...(inputProperty === undefined
              ? { arguments: JSON.stringify(block.arguments) }
              : { input: grammarInput(block, inputProperty) }),
            ...(isSameModel && block.namespace !== undefined ? { namespace: block.namespace } : {}),
          });
        }
      }
      if (output.length === 0) continue;
      projected.push(...output);
    } else {
      const [callId] = message.toolCallId.split("|");
      projected.push({
        type: grammarToolInputProperties.has(message.toolName)
          ? "custom_tool_call_output"
          : "function_call_output",
        call_id: callId,
        output: toolResultOutput(model, message.content),
      });
    }
    if (!isLeadingSystemMessage) messageIndex++;
  }

  return projected;
}

function projectToolDeclarations(tools: readonly Tool[], model: Model<any>, toolSearchResult = false): ResponsesItem[] {
  const codex = model.api === "openai-codex-responses";
  const supportsStrict = (model.compat as OpenAIResponsesCompat | undefined)?.supportsStrictMode ?? codex;
  return tools.map(tool => {
    const grammar = grammarDefinition(tool, model);
    if (grammar) return {
      type: "custom", name: tool.name, description: tool.description,
      format: { type: "grammar", syntax: grammar.syntax, definition: grammar.definition },
      ...(toolSearchResult ? { defer_loading: true } : {}),
    };
    return { ...projectJsonSchemaTool(tool, supportsStrict, codex ? null : false),
      ...(toolSearchResult ? { defer_loading: true } : {}) };
  });
}

export function projectCompactableContext(
  messages: readonly AgentMessage[],
  model: Model<any>,
  options: CompactableContextOptions = { includeSystemPrompt: true },
): ProjectedContext {
  const supportsMidConvoSystemMessages =
    (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)
      ?.supportsMidConvoSystemMessages ?? false;
  const context = normalizeContext({ messages: convertToLlm([...messages]) });
  const declarationMessages = options.declarationMessages
    ? convertToLlm([...options.declarationMessages])
    : options.checkpointSystemMessage
      ? [options.checkpointSystemMessage, ...context.messages]
      : context.messages;
  const resolved = resolveTranscript(context, supportsMidConvoSystemMessages);
  const toolContext = resolveTranscript(normalizeContext({ messages: declarationMessages }), supportsMidConvoSystemMessages);
  const grammarToolInputProperties = grammarInputProperties(getDeclaredTools(toolContext.messages), model);
  const compat = model.compat as OpenAIResponsesCompat | undefined;
  const transcriptTools = resolveTranscriptTools(toolContext.messages,
    (compat?.supportsAdditionalTools ?? false) || (compat?.supportsToolSearch ?? false));
  return {
    input: projectNormalizedMessages(
      normalizeMessages(resolved.messages, model), model, options, grammarToolInputProperties, transcriptTools.anchorsAdditions,
    ),
    tools: projectToolDeclarations(transcriptTools.requestTools, model),
  };
}
