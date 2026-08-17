/**
 * Codex-style remote compaction helpers.
 *
 * Converts Pi messages into OpenAI Responses items, requests remote compaction
 * through the Responses API's `compaction_trigger`, stores the returned opaque
 * replacement history, and reconstructs replayable state from persisted Pi
 * session entries.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  type Model,
  type ProviderHeaders,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  hostnameFromBaseUrl,
  isRecord,
  messageMatchesModel,
  supportsRemoteCompactionModel,
  modelKey,
} from "./openai.ts";

type AssistantPhase = "commentary" | "final_answer";
type InputImageItem = { type: "input_image"; image_url: string; detail?: "auto" };
type ToolResultOutputItem =
  | { type: "input_text"; text: string }
  | InputImageItem;

type ContentPartLike = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  source?: unknown;
};

export type ResponseContentItem =
  | { type: "input_text"; text: string }
  | InputImageItem
  | { type: "output_text"; text: string; annotations?: unknown[] };

export type ResponseItem =
  | {
      type: "message";
      role: string;
      content: ResponseContentItem[] | string;
      end_turn?: boolean;
      phase?: AssistantPhase;
    }
  | {
      type: "reasoning";
      summary: Array<{ type: "summary_text"; text: string }>;
      content?: Array<{ type: "reasoning_text" | "text"; text: string }>;
      encrypted_content: string | null;
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string | ToolResultOutputItem[] }
  | { type: "compaction"; encrypted_content: string }
  | { type: "compaction_summary"; encrypted_content: string }
  | { type: "compaction_trigger" }
  | { type: string; [key: string]: unknown };

export type ResponsesReasoningConfig = {
  effort?: string;
  summary?: "auto" | "concise" | "detailed" | null;
};

export type RemoteCompactionTextConfig = {
  verbosity: string;
};

export type RemoteCompactionUsageSnapshot = Usage;

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const APPROXIMATE_CHARS_PER_TOKEN = 4;
const APPROXIMATE_IMAGE_CHARS = 4_800;
const REMOTE_COMPACTION_MESSAGE_TRUNCATION_MARKER =
  "\n\n[... content truncated to fit the remote compaction context ...]\n\n";
// Keep this aligned with Codex's model-visible marker for rewritten outputs.
export const CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE =
  "Output exceeded the available model context and was truncated";
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";
export const REMOTE_COMPACTION_CHECKPOINT_SUMMARY =
  "[Remote Responses compaction checkpoint]\n\n" +
  "Detailed context before this checkpoint is retained in the native replay artifact and is available only to compatible Responses models.";
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES = 2;
const REMOTE_COMPACTION_STREAM_IDLE_TIMEOUT_MS = 300_000;
const REMOTE_COMPACTION_RETRY_BASE_DELAY_MS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RemoteCompactionDetails = {
  version: 1 | 2;
  provider: "openai-responses-compact" | "openai-responses-compaction";
  implementation?: "responses_compact_v1" | "responses_compaction_v2";
  modelKey: string;
  replacementHistory: ResponseItem[];
  usage?: RemoteCompactionUsageSnapshot;
};

export type RemoteCompactionSessionState = {
  compactionEntryId: string;
  modelKey: string;
  replacementHistory: ResponseItem[];
};

export type RemoteCompactionResult = {
  output: ResponseItem[];
  usage?: RemoteCompactionUsageSnapshot;
};

export type RemoteCompactionRetry = {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: Error;
};

class RemoteCompactionRequestError extends Error {
  readonly retryable: boolean;
  readonly retryDelayMs?: number;

  constructor(message: string, retryable: boolean, retryDelayMs?: number) {
    super(message);
    this.name = "RemoteCompactionRequestError";
    this.retryable = retryable;
    this.retryDelayMs = retryDelayMs;
  }
}

function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\/+$/, "");
}

function assertRemoteCompactionModel(model: unknown): void {
  if (!supportsRemoteCompactionModel(model)) {
    throw new Error("Remote compaction v2 requires an openai-responses model.");
  }
}

function resolveResponsesEndpoint(model: Model<any>, resolvedBaseUrl?: string): string {
  const modelBaseUrl = normalizeBaseUrl(
    typeof model.baseUrl === "string" ? model.baseUrl : undefined,
    "https://api.openai.com/v1",
  );
  const baseUrl = normalizeBaseUrl(resolvedBaseUrl, modelBaseUrl);
  return baseUrl.endsWith("/responses") ? baseUrl : `${baseUrl}/responses`;
}

export function remoteCompactionV2EndpointUrl(
  model: Model<any>,
  resolvedBaseUrl?: string,
): string {
  assertRemoteCompactionModel(model);
  return resolveResponsesEndpoint(model, resolvedBaseUrl);
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : join(homedir(), ".codex");
}

function resolveCodexInstallationId(): string {
  const path = join(resolveCodexHome(), "installation_id");
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (UUID_RE.test(existing)) return existing.toLowerCase();
    }
  } catch {
    // Fall through and regenerate below, matching Codex's invalid-file behavior.
  }

  const installationId = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, installationId);
  } catch {
    // Header is a parity hint, not a reason to fail compaction.
  }
  return installationId;
}

export function buildCodexIdentityHeaders(sessionId?: string): Record<string, string> {
  if (!sessionId) {
    return {
      "x-codex-installation-id": resolveCodexInstallationId(),
    };
  }
  return {
    "x-codex-installation-id": resolveCodexInstallationId(),
    "x-codex-window-id": `${sessionId}:0`,
    session_id: sessionId,
  };
}

function deleteHeaderCaseInsensitively(headers: Record<string, string>, name: string): void {
  const expected = name.toLowerCase();
  for (const existingName of Object.keys(headers)) {
    if (existingName.toLowerCase() === expected) delete headers[existingName];
  }
}

function setHeaderCaseInsensitively(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  deleteHeaderCaseInsensitively(headers, name);
  headers[name] = value;
}

function applyProviderHeaders(
  headers: Record<string, string>,
  providerHeaders: ProviderHeaders | undefined,
): Set<string> {
  const deletedHeaderNames = new Set<string>();
  for (const [name, value] of Object.entries(providerHeaders ?? {})) {
    const normalizedName = name.toLowerCase();
    if (value === null) {
      deleteHeaderCaseInsensitively(headers, name);
      deletedHeaderNames.add(normalizedName);
      continue;
    }
    setHeaderCaseInsensitively(headers, name, value);
    deletedHeaderNames.delete(normalizedName);
  }
  return deletedHeaderNames;
}

function addRemoteCompactionV2Feature(
  headers: Record<string, string>,
  deletedHeaderNames: ReadonlySet<string>,
): void {
  if (deletedHeaderNames.has("x-codex-beta-features")) return;

  const configuredFeatures = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "x-codex-beta-features")?.[1]
    ?.split(",")
    .map((feature) => feature.trim())
    .filter(Boolean) ?? [];
  const features = [...new Set([...configuredFeatures, REMOTE_COMPACTION_V2_FEATURE])];
  setHeaderCaseInsensitively(headers, "x-codex-beta-features", features.join(","));
}

export function buildRemoteCompactionHeaders(params: {
  model: Model<any>;
  apiKey?: string;
  headers?: ProviderHeaders;
  sessionId?: string;
}): Record<string, string> {
  assertRemoteCompactionModel(params.model);
  const headers: Record<string, string> = {};
  if (params.apiKey) {
    setHeaderCaseInsensitively(headers, "authorization", `Bearer ${params.apiKey}`);
  }
  for (const [name, value] of Object.entries(buildCodexIdentityHeaders(params.sessionId))) {
    setHeaderCaseInsensitively(headers, name, value);
  }
  const deletedHeaderNames = applyProviderHeaders(headers, params.headers);
  if (!deletedHeaderNames.has("accept")) {
    setHeaderCaseInsensitively(headers, "accept", "text/event-stream");
  }
  if (!deletedHeaderNames.has("content-type")) {
    setHeaderCaseInsensitively(headers, "content-type", "application/json");
  }
  addRemoteCompactionV2Feature(headers, deletedHeaderNames);
  return headers;
}

function isAssistantPhase(value: unknown): value is AssistantPhase {
  return value === "commentary" || value === "final_answer";
}

type ParsedTextSignature = {
  id?: string;
  phase?: AssistantPhase;
};

function parseTextSignature(value: unknown): ParsedTextSignature | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (!value.startsWith("{")) return { id: value };

  try {
    const parsed = JSON.parse(value) as { v?: unknown; id?: unknown; phase?: unknown };
    if (parsed.v !== 1 || typeof parsed.id !== "string") return undefined;
    return {
      id: parsed.id,
      ...(isAssistantPhase(parsed.phase) ? { phase: parsed.phase } : {}),
    };
  } catch {
    return undefined;
  }
}

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function createInputImageItem(imageUrl: string): InputImageItem {
  return { type: "input_image", image_url: imageUrl, detail: "auto" };
}

function contentToResponseContentItems(
  content: unknown,
  unsupportedImagePlaceholder?: string,
): ResponseContentItem[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: sanitizeSurrogates(content) }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: ResponseContentItem[] = [];
  let previousWasPlaceholder = false;
  for (const part of content as ContentPartLike[]) {
    if (
      (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      const text = sanitizeSurrogates(part.text);
      items.push({ type: "input_text", text });
      previousWasPlaceholder = text === unsupportedImagePlaceholder;
      continue;
    }
    if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      if (unsupportedImagePlaceholder) {
        if (!previousWasPlaceholder) {
          items.push({ type: "input_text", text: unsupportedImagePlaceholder });
        }
        previousWasPlaceholder = true;
      } else {
        items.push(createInputImageItem(`data:${part.mimeType};base64,${part.data}`));
        previousWasPlaceholder = false;
      }
      continue;
    }
    if (
      part.type === "input_image" &&
      part.source &&
      typeof part.source === "object" &&
      (part.source as { type?: unknown }).type === "url" &&
      typeof (part.source as { url?: unknown }).url === "string"
    ) {
      if (unsupportedImagePlaceholder) {
        if (!previousWasPlaceholder) {
          items.push({ type: "input_text", text: unsupportedImagePlaceholder });
        }
        previousWasPlaceholder = true;
      } else {
        items.push(createInputImageItem((part.source as { url: string }).url));
        previousWasPlaceholder = false;
      }
      continue;
    }
    previousWasPlaceholder = false;
  }
  return items;
}

function toolResultContentToOutput(
  content: unknown,
  model?: { input?: readonly unknown[] },
): string | ToolResultOutputItem[] {
  if (typeof content === "string") return sanitizeSurrogates(content);
  if (!Array.isArray(content)) return "(no tool output)";

  const supportsImages = modelSupportsImageInput(model ?? {});
  const converted = contentToResponseContentItems(
    content,
    supportsImages ? undefined : NON_VISION_TOOL_IMAGE_PLACEHOLDER,
  );
  const text = converted
    .filter((item): item is Extract<ResponseContentItem, { type: "input_text" }> => (
      item.type === "input_text"
    ))
    .map((item) => item.text)
    .join("\n");
  const images = converted.filter((item): item is InputImageItem => item.type === "input_image");

  if (images.length === 0) return text || "(no tool output)";
  return [
    ...(text ? [{ type: "input_text" as const, text }] : []),
    ...images,
  ];
}

function parseThinkingSignature(value: unknown): ResponseItem | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isResponseItem(parsed) && parsed.type === "reasoning" ? cloneResponseItem(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function isResponseItem(value: unknown): value is ResponseItem {
  return isRecord(value) && typeof value.type === "string";
}

function isCompactionItem(value: unknown): value is ResponseItem {
  return isRecord(value) &&
    (value.type === "compaction" || value.type === "compaction_summary") &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0;
}

function normalizeResponseIdPart(part: string): string {
  const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.slice(0, 64).replace(/_+$/, "");
}

function shortHash(value: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const character = value.charCodeAt(index);
    first = Math.imul(first ^ character, 2654435761);
    second = Math.imul(second ^ character, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^
    Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^
    Math.imul(first ^ (first >>> 13), 3266489909);
  return (second >>> 0).toString(36) + (first >>> 0).toString(36);
}

function normalizeToolCallIdForTarget(
  id: string,
  source: Extract<AgentMessage, { role: "assistant" }>,
  model: Model<any>,
): string {
  if (!OPENAI_TOOL_CALL_PROVIDERS.has(model.provider)) return normalizeResponseIdPart(id);
  if (!id.includes("|")) return normalizeResponseIdPart(id);

  const [callId, itemId] = id.split("|");
  const normalizedCallId = normalizeResponseIdPart(callId);
  const isForeign = source.provider !== model.provider || source.api !== model.api;
  let normalizedItemId = isForeign
    ? `fc_${shortHash(itemId)}`
    : normalizeResponseIdPart(itemId);
  if (!normalizedItemId.startsWith("fc_")) {
    normalizedItemId = normalizeResponseIdPart(`fc_${normalizedItemId}`);
  }
  return `${normalizedCallId}|${normalizedItemId}`;
}

function assistantMessageMatchesTarget(
  message: Extract<AgentMessage, { role: "assistant" }>,
  model: Model<any> | undefined,
): boolean {
  return !model || messageMatchesModel(message, model);
}

function fallbackAssistantMessageId(messageIndex: number, textBlockIndex: number): string {
  return textBlockIndex === 0
    ? `msg_pi_${messageIndex}`
    : `msg_pi_${messageIndex}_${textBlockIndex}`;
}

/**
 * Pi 0.84's production extension loader does not expose pi-ai's public `api/*`
 * runtime subpaths. Keep this narrow adapter aligned with Pi's ordinary
 * OpenAI Responses conversion until the loader exposes the shared converter.
 */
export function messageToResponseItems(
  message: AgentMessage,
  model?: Model<any>,
  messageIndex?: number,
): ResponseItem[] {
  const items: ResponseItem[] = [];

  if (message.role === "user") {
    const content = contentToResponseContentItems(
      message.content,
      model && !modelSupportsImageInput(model)
        ? NON_VISION_USER_IMAGE_PLACEHOLDER
        : undefined,
    );
    if (content.length > 0) {
      items.push({ type: "message", role: "user", content });
    }
    return items;
  }

  if (message.role === "assistant") {
    if (message.stopReason === "error" || message.stopReason === "aborted") return items;

    const sameModel = assistantMessageMatchesTarget(message, model);
    const sameProviderAndApi = !model || (
      message.provider === model.provider && message.api === model.api
    );
    const differentModel = Boolean(model && sameProviderAndApi && message.model !== model.id);
    let textBlockIndex = 0;

    for (const block of message.content) {
      if (block.type === "thinking") {
        if (block.redacted && !sameModel) continue;
        if (sameModel) {
          const reasoning = parseThinkingSignature(block.thinkingSignature);
          if (reasoning) items.push(reasoning);
        } else if (block.thinking.trim()) {
          const id = messageIndex === undefined
            ? undefined
            : fallbackAssistantMessageId(messageIndex, textBlockIndex++);
          items.push({
            type: "message",
            ...(id ? { id } : {}),
            role: "assistant",
            content: [{
              type: "output_text",
              text: sanitizeSurrogates(block.thinking),
              annotations: [],
            }],
            status: "completed",
          });
        }
        continue;
      }

      if (block.type === "text") {
        const signature = sameModel ? parseTextSignature(block.textSignature) : undefined;
        const fallbackId = messageIndex === undefined
          ? undefined
          : fallbackAssistantMessageId(messageIndex, textBlockIndex);
        textBlockIndex++;
        const id = signature?.id && signature.id.length <= 64 ? signature.id : fallbackId;
        items.push({
          type: "message",
          ...(id ? { id } : {}),
          role: "assistant",
          content: [{
            type: "output_text",
            text: sanitizeSurrogates(block.text),
            annotations: [],
          }],
          status: "completed",
          ...(signature?.phase ? { phase: signature.phase } : {}),
        });
        continue;
      }

      if (block.type !== "toolCall") continue;

      const [callId, itemId] = block.id.split("|");
      const responseItemId = !differentModel && itemId?.startsWith("fc_") ? itemId : undefined;
      const namespace = (block as typeof block & { namespace?: unknown }).namespace;
      items.push({
        type: "function_call",
        ...(responseItemId ? { id: responseItemId } : {}),
        name: block.name,
        call_id: callId,
        arguments: JSON.stringify(block.arguments ?? {}),
        ...(sameModel && typeof namespace === "string" ? { namespace } : {}),
      });
    }

    return items;
  }

  if (message.role === "toolResult") {
    items.push({
      type: "function_call_output",
      call_id: message.toolCallId.split("|", 1)[0],
      output: toolResultContentToOutput(message.content, model),
    });
  }

  return items;
}

export function messagesToResponseItems(
  messages: AgentMessage[],
  model?: Model<any>,
): ResponseItem[] {
  const normalizedToolCallIds = new Map<string, string>();
  const transformedMessages = messages.map((message): AgentMessage => {
    if (message.role === "assistant" && model && !assistantMessageMatchesTarget(message, model)) {
      return {
        ...message,
        content: message.content.map((block) => {
          if (block.type !== "toolCall") return block;
          const normalizedId = normalizeToolCallIdForTarget(block.id, message, model);
          normalizedToolCallIds.set(block.id, normalizedId);
          return normalizedId === block.id ? block : { ...block, id: normalizedId };
        }),
      };
    }
    if (message.role === "toolResult") {
      const normalizedId = normalizedToolCallIds.get(message.toolCallId);
      return normalizedId ? { ...message, toolCallId: normalizedId } : message;
    }
    return message;
  });

  return transformedMessages.flatMap((message, index) => (
    messageToResponseItems(message, model, index)
  ));
}

function cloneResponseItem(item: ResponseItem): ResponseItem {
  return JSON.parse(JSON.stringify(item)) as ResponseItem;
}

function responseItemCallId(item: ResponseItem): string | undefined {
  const callId = (item as Record<string, unknown>).call_id;
  return typeof callId === "string" && callId ? callId : undefined;
}

function responseItemOutput(item: ResponseItem): unknown {
  return (item as Record<string, unknown>).output;
}

function syntheticOutputForCall(item: ResponseItem): ResponseItem | undefined {
  const callId = responseItemCallId(item);
  if (!callId) return undefined;

  if (item.type === "function_call" || item.type === "local_shell_call") {
    return { type: "function_call_output", call_id: callId, output: "No result provided" };
  }
  if (item.type === "tool_search_call") {
    return {
      type: "tool_search_output",
      call_id: callId,
      status: "completed",
      execution: "client",
      tools: [],
    };
  }
  if (item.type === "custom_tool_call") {
    return { type: "custom_tool_call_output", call_id: callId, output: "aborted" };
  }
  return undefined;
}

function outputTypeForCallType(type: string): string | undefined {
  if (type === "function_call" || type === "local_shell_call") return "function_call_output";
  if (type === "tool_search_call") return "tool_search_output";
  if (type === "custom_tool_call") return "custom_tool_call_output";
  return undefined;
}

function ensureCallOutputsPresent(items: ResponseItem[]): ResponseItem[] {
  const normalized: ResponseItem[] = [];
  for (const item of items) {
    normalized.push(item);
    const outputType = outputTypeForCallType(item.type);
    const callId = responseItemCallId(item);
    if (!outputType || !callId) continue;

    const hasOutput = items.some((candidate) => (
      candidate.type === outputType &&
      responseItemCallId(candidate) === callId
    ));
    if (!hasOutput) {
      const synthetic = syntheticOutputForCall(item);
      if (synthetic) normalized.push(synthetic);
    }
  }
  return normalized;
}

function removeOrphanOutputs(items: ResponseItem[]): ResponseItem[] {
  const functionCallIds = new Set<string>();
  const toolSearchCallIds = new Set<string>();
  const customToolCallIds = new Set<string>();

  for (const item of items) {
    const callId = responseItemCallId(item);
    if (!callId) continue;
    if (item.type === "function_call" || item.type === "local_shell_call") {
      functionCallIds.add(callId);
    } else if (item.type === "tool_search_call") {
      toolSearchCallIds.add(callId);
    } else if (item.type === "custom_tool_call") {
      customToolCallIds.add(callId);
    }
  }

  return items.filter((item) => {
    const callId = responseItemCallId(item);
    if (item.type === "function_call_output") {
      return Boolean(callId && functionCallIds.has(callId));
    }
    if (item.type === "custom_tool_call_output") {
      return Boolean(callId && customToolCallIds.has(callId));
    }
    if (item.type === "tool_search_output") {
      if (item.execution === "server" || callId === undefined) return true;
      return toolSearchCallIds.has(callId);
    }
    return true;
  });
}

function modelSupportsImageInput(model: { input?: readonly unknown[] }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function stripUnsupportedImageContentItems(items: ResponseContentItem[]): ResponseContentItem[] {
  return items.map((item) => (
    item.type === "input_image"
      ? { type: "input_text", text: NON_VISION_USER_IMAGE_PLACEHOLDER }
      : item
  ));
}

function stripUnsupportedFunctionOutputImages(output: unknown): unknown {
  if (Array.isArray(output)) {
    return output.map((item) => (
      isRecord(item) && item.type === "input_image"
        ? { type: "input_text", text: NON_VISION_TOOL_IMAGE_PLACEHOLDER }
        : item
    ));
  }
  if (isRecord(output) && Array.isArray(output.content)) {
    return {
      ...output,
      content: stripUnsupportedFunctionOutputImages(output.content),
    };
  }
  return output;
}

function stripImagesWhenUnsupported(items: ResponseItem[], model: { input?: readonly unknown[] }): ResponseItem[] {
  if (modelSupportsImageInput(model)) return items;

  return items.map((item) => {
    const next = cloneResponseItem(item);
    if (next.type === "message" && Array.isArray(next.content)) {
      next.content = stripUnsupportedImageContentItems(next.content);
    } else if (
      (next.type === "function_call_output" || next.type === "custom_tool_call_output") &&
      "output" in next
    ) {
      next.output = stripUnsupportedFunctionOutputImages(responseItemOutput(next));
    } else if (next.type === "image_generation_call" && typeof next.result === "string") {
      next.result = "";
    }
    return next;
  });
}

export function normalizeResponseItemsForPrompt(
  items: ResponseItem[],
  model: { input?: readonly unknown[] },
): ResponseItem[] {
  const withoutGhostSnapshots = items
    .filter((item) => item.type !== "ghost_snapshot")
    .map(cloneResponseItem);
  const withCallOutputs = ensureCallOutputsPresent(withoutGhostSnapshots);
  const withoutOrphanOutputs = removeOrphanOutputs(withCallOutputs);
  return stripImagesWhenUnsupported(withoutOrphanOutputs, model);
}

function isRealUserMessage(item: ResponseItem): boolean {
  if (item.type !== "message" || item.role !== "user") return false;
  if (typeof item.content === "string") return item.content.trim().length > 0;
  return Array.isArray(item.content) && item.content.length > 0;
}

function shouldKeepCompactedHistoryItem(item: ResponseItem): boolean {
  if (item.type === "message" && item.role === "developer") return false;
  if (item.type === "message" && item.role === "user") return isRealUserMessage(item);
  if (item.type === "message" && item.role === "assistant") return true;
  if (item.type === "compaction" || item.type === "compaction_summary") return true;
  return false;
}

export function processCompactedHistory(items: ResponseItem[]): ResponseItem[] {
  return items.filter(shouldKeepCompactedHistoryItem).map(cloneResponseItem);
}

function responseMessageText(item: ResponseItem): string {
  if (item.type !== "message") return "";
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((content): content is Extract<ResponseContentItem, { type: "input_text" | "output_text" }> =>
      content.type === "input_text" || content.type === "output_text",
    )
    .map((content) => content.text)
    .join("");
}

function approximateMessageTokens(item: ResponseItem): number {
  return Math.max(1, Math.ceil(responseMessageText(item).length / 4));
}

function truncateMessageToTokenBudget(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
  if (item.type !== "message") return cloneResponseItem(item);
  if (typeof item.content === "string") {
    const text = sanitizeSurrogates(item.content.slice(0, Math.max(0, maxTokens * 4)));
    return text ? { ...cloneResponseItem(item), content: text } : undefined;
  }
  if (!Array.isArray(item.content)) return cloneResponseItem(item);
  let remainingCharacters = Math.max(0, maxTokens * 4);
  const content = item.content.flatMap((part) => {
    if (part.type === "input_image") return [part];
    if (remainingCharacters === 0) return [];
    const rawText = part.text.slice(0, remainingCharacters);
    remainingCharacters -= rawText.length;
    const text = sanitizeSurrogates(rawText);
    return text ? [{ ...part, text }] : [];
  });
  return content.length > 0 ? { ...cloneResponseItem(item), content } : undefined;
}

function truncateRetainedMessages(items: ResponseItem[], maxTokens: number): ResponseItem[] {
  let remainingTokens = maxTokens;
  const retainedReversed: ResponseItem[] = [];
  for (const item of [...items].reverse()) {
    if (remainingTokens === 0) break;
    const tokenCount = approximateMessageTokens(item);
    if (tokenCount <= remainingTokens) {
      retainedReversed.push(cloneResponseItem(item));
      remainingTokens -= tokenCount;
      continue;
    }
    const truncated = truncateMessageToTokenBudget(item, remainingTokens);
    if (truncated) retainedReversed.push(truncated);
    remainingTokens = 0;
  }
  return retainedReversed.reverse();
}

export function buildRemoteCompactionV2History(
  input: ResponseItem[],
  compactionItem: ResponseItem,
): ResponseItem[] {
  if (compactionItem.type !== "compaction") {
    throw new Error("OpenAI remote compaction v2 did not return a compaction item.");
  }
  const retainedUserMessages = input.filter(
    (item) => item.type === "message" && item.role === "user" && isRealUserMessage(item),
  );
  return [
    ...truncateRetainedMessages(retainedUserMessages, RETAINED_MESSAGE_TOKEN_BUDGET),
    cloneResponseItem(compactionItem),
  ];
}

export function buildToolsPayload(
  allTools: ToolInfo[],
  activeToolNames: string[],
  supportsStrictMode = false,
): Record<string, unknown>[] {
  const active = new Set(activeToolNames);
  return allTools
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(supportsStrictMode ? { strict: false } : {}),
    }));
}

function extractCacheWriteTokens(value: unknown): number {
  if (!isRecord(value)) return 0;
  const cacheCreationTokens = value.cache_creation_tokens;
  if (typeof cacheCreationTokens === "number" && Number.isFinite(cacheCreationTokens)) {
    return cacheCreationTokens;
  }
  const cacheWriteTokens = value.cache_write_tokens;
  return typeof cacheWriteTokens === "number" && Number.isFinite(cacheWriteTokens)
    ? cacheWriteTokens
    : 0;
}

// Pi's ordinary OpenAI Responses pricing helper is private to that adapter.
// Keep this narrow parity copy aligned until pi-ai exposes a public equivalent.
function getResponsesServiceTierCostMultiplier(
  model: Model<any>,
  serviceTier: string | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return model.id === "gpt-5.5" ? 2.5 : 2;
    default:
      return 1;
  }
}

function applyResponsesServiceTierPricing(
  model: Model<any>,
  usage: RemoteCompactionUsageSnapshot,
  serviceTier: string | undefined,
): void {
  const multiplier = getResponsesServiceTierCostMultiplier(model, serviceTier);
  if (multiplier === 1) return;

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function extractRemoteCompactionUsage(
  model: Model<any>,
  value: unknown,
  serviceTier: string | undefined,
): RemoteCompactionUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens = typeof value.input_tokens === "number" && Number.isFinite(value.input_tokens)
    ? value.input_tokens
    : 0;
  const outputTokens = typeof value.output_tokens === "number" && Number.isFinite(value.output_tokens)
    ? value.output_tokens
    : 0;
  const totalTokens = typeof value.total_tokens === "number" && Number.isFinite(value.total_tokens)
    ? value.total_tokens
    : inputTokens + outputTokens;
  const inputTokenDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const cachedTokens = typeof inputTokenDetails?.cached_tokens === "number" && Number.isFinite(inputTokenDetails.cached_tokens)
    ? inputTokenDetails.cached_tokens
    : 0;
  const cacheWriteTokens = extractCacheWriteTokens(inputTokenDetails);

  const usage: RemoteCompactionUsageSnapshot = {
    input: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  applyResponsesServiceTierPricing(model, usage, serviceTier);
  return usage;
}

function parseUsageCostSnapshot(value: unknown): RemoteCompactionUsageSnapshot["cost"] | undefined {
  if (!isRecord(value)) return undefined;
  const input = typeof value.input === "number" && Number.isFinite(value.input) ? value.input : 0;
  const output = typeof value.output === "number" && Number.isFinite(value.output) ? value.output : 0;
  const cacheRead = typeof value.cacheRead === "number" && Number.isFinite(value.cacheRead) ? value.cacheRead : 0;
  const cacheWrite = typeof value.cacheWrite === "number" && Number.isFinite(value.cacheWrite) ? value.cacheWrite : 0;
  const total = typeof value.total === "number" && Number.isFinite(value.total)
    ? value.total
    : input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

function parseRemoteCompactionUsageSnapshot(value: unknown): RemoteCompactionUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const input = typeof value.input === "number" && Number.isFinite(value.input) ? value.input : 0;
  const output = typeof value.output === "number" && Number.isFinite(value.output) ? value.output : 0;
  const cacheRead = typeof value.cacheRead === "number" && Number.isFinite(value.cacheRead) ? value.cacheRead : 0;
  const cacheWrite = typeof value.cacheWrite === "number" && Number.isFinite(value.cacheWrite) ? value.cacheWrite : 0;
  const totalTokens = typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens)
    ? value.totalTokens
    : input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: parseUsageCostSnapshot(value.cost) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

type RemoteCompactionRequestBodyParams = {
  model: Model<any>;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  parallelToolCalls: boolean;
  reasoning?: ResponsesReasoningConfig;
  text?: RemoteCompactionTextConfig;
  serviceTier?: string;
  sessionId?: string;
};

export function buildRemoteCompactionRequestBody(
  params: RemoteCompactionRequestBodyParams,
): Record<string, unknown> {
  return {
    model: params.model.id,
    input: [...params.input, { type: "compaction_trigger" }],
    instructions: params.instructions,
    tools: params.tools,
    parallel_tool_calls: params.parallelToolCalls,
    tool_choice: "auto",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(params.sessionId ? { prompt_cache_key: params.sessionId } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.text ? { text: params.text } : {}),
    ...(params.serviceTier !== undefined ? { service_tier: params.serviceTier } : {}),
  };
}

function approximateOpaqueItemCharacters(encodedLength: number): number {
  return Math.max(0, Math.floor((encodedLength * 3) / 4) - 650);
}

function tokenEstimateReplacer(
  this: Record<string, unknown>,
  key: string,
  value: unknown,
): unknown {
  if (
    key === "encrypted_content" &&
    typeof value === "string" &&
    (this.type === "reasoning" || this.type === "compaction" || this.type === "compaction_summary")
  ) {
    return "e".repeat(approximateOpaqueItemCharacters(value.length));
  }
  if (
    key === "image_url" &&
    typeof value === "string" &&
    /^data:image\/[^;,]+(?:;[^,]*)?;base64,/i.test(value)
  ) {
    return "i".repeat(APPROXIMATE_IMAGE_CHARS);
  }
  return value;
}

function approximateSerializedCharacters(value: unknown): number {
  return (JSON.stringify(value, tokenEstimateReplacer) ?? "").length;
}

function approximateTokensFromCharacters(characters: number): number {
  return Math.max(1, Math.ceil(characters / APPROXIMATE_CHARS_PER_TOKEN));
}

function approximateSerializedTokens(value: unknown): number {
  return approximateTokensFromCharacters(approximateSerializedCharacters(value));
}

export function estimateRemoteCompactionRequestTokens(
  params: RemoteCompactionRequestBodyParams,
): number {
  return approximateSerializedTokens(buildRemoteCompactionRequestBody(params));
}

function rewrittenOutputForContextWindow(item: ResponseItem): ResponseItem | undefined {
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    if (responseItemOutput(item) === CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE) return undefined;
    return {
      ...cloneResponseItem(item),
      output: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
    };
  }
  if (item.type === "tool_search_output" && Array.isArray(item.tools) && item.tools.length > 0) {
    return { ...cloneResponseItem(item), tools: [] };
  }
  return undefined;
}

function messageText(item: ResponseItem): string | undefined {
  if (item.type !== "message") return undefined;
  if (typeof item.content === "string") return item.content || undefined;
  if (!Array.isArray(item.content)) return undefined;
  const text = item.content
    .filter(
      (part): part is Extract<ResponseContentItem, { type: "input_text" | "output_text" }> =>
        part.type === "input_text" || part.type === "output_text",
    )
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function takeCodePointPrefix(text: string, count: number): string {
  return sanitizeSurrogates(Array.from(text).slice(0, count).join(""));
}

function takeCodePointSuffix(text: string, count: number): string {
  if (count === 0) return "";
  return sanitizeSurrogates(Array.from(text).slice(-count).join(""));
}

function truncateTextHeadAndTail(text: string, retainedCharacters: number): string {
  const availableCharacters = Math.max(2, Math.min(retainedCharacters, codePointLength(text) - 1));
  const headCharacters = Math.ceil(availableCharacters / 2);
  const tailCharacters = Math.floor(availableCharacters / 2);
  return (
    takeCodePointPrefix(text, headCharacters) +
    REMOTE_COMPACTION_MESSAGE_TRUNCATION_MARKER +
    takeCodePointSuffix(text, tailCharacters)
  );
}

function allocateTextPartCharacters(
  content: ResponseContentItem[],
  characterBudget: number,
  fromEnd: boolean,
): number[] {
  const allocations = Array<number>(content.length).fill(0);
  let remaining = characterBudget;
  const indexes = content.map((_, index) => index);
  if (fromEnd) indexes.reverse();

  for (const index of indexes) {
    const part = content[index];
    if (part.type !== "input_text" && part.type !== "output_text") continue;
    const retained = Math.min(remaining, codePointLength(part.text));
    allocations[index] = retained;
    remaining -= retained;
    if (remaining === 0) break;
  }
  return allocations;
}

function truncateMessageText(
  item: ResponseItem,
  retainedCharacters: number,
): ResponseItem | undefined {
  const text = messageText(item);
  if (!text || item.type !== "message") return undefined;
  if (typeof item.content === "string") {
    return {
      ...cloneResponseItem(item),
      content: truncateTextHeadAndTail(item.content, retainedCharacters),
    };
  }
  if (!Array.isArray(item.content)) return undefined;

  const totalCharacters = codePointLength(text);
  const availableCharacters = Math.max(2, Math.min(retainedCharacters, totalCharacters - 1));
  const headCharacters = Math.ceil(availableCharacters / 2);
  const tailCharacters = Math.floor(availableCharacters / 2);
  const headAllocations = allocateTextPartCharacters(item.content, headCharacters, false);
  const tailAllocations = allocateTextPartCharacters(item.content, tailCharacters, true);
  let markerPartIndex = -1;
  for (let index = headAllocations.length - 1; index >= 0; index--) {
    if (headAllocations[index] > 0) {
      markerPartIndex = index;
      break;
    }
  }
  if (markerPartIndex < 0) return undefined;

  const content = item.content.flatMap((part, index) => {
    if (part.type !== "input_text" && part.type !== "output_text") return [part];
    const prefix = takeCodePointPrefix(part.text, headAllocations[index]);
    const suffix = takeCodePointSuffix(part.text, tailAllocations[index]);
    const marker = index === markerPartIndex ? REMOTE_COMPACTION_MESSAGE_TRUNCATION_MARKER : "";
    const retainedText = prefix + marker + suffix;
    return retainedText ? [{ ...part, text: retainedText }] : [];
  });
  return { ...cloneResponseItem(item), content };
}

function isProtectedCompactionItem(item: ResponseItem): boolean {
  return item.type === "compaction" || item.type === "compaction_summary";
}

function responseItemPairKey(item: ResponseItem): string | undefined {
  const callId = responseItemCallId(item);
  if (!callId) return undefined;
  const outputType = outputTypeForCallType(item.type);
  if (outputType) return `${outputType}:${callId}`;
  if (
    item.type === "function_call_output" ||
    item.type === "tool_search_output" ||
    item.type === "custom_tool_call_output"
  ) {
    return `${item.type}:${callId}`;
  }
  return undefined;
}

function removableHistoryGroups(items: ResponseItem[]): number[][] {
  const pairIndexes = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (isProtectedCompactionItem(item)) return;
    const pairKey = responseItemPairKey(item);
    if (!pairKey) return;
    const indexes = pairIndexes.get(pairKey) ?? [];
    indexes.push(index);
    pairIndexes.set(pairKey, indexes);
  });

  const groups: number[][] = [];
  const emittedPairKeys = new Set<string>();
  items.forEach((item, index) => {
    if (isProtectedCompactionItem(item)) return;
    const pairKey = responseItemPairKey(item);
    if (!pairKey) {
      groups.push([index]);
      return;
    }
    if (emittedPairKeys.has(pairKey)) return;
    emittedPairKeys.add(pairKey);
    groups.push(pairIndexes.get(pairKey) ?? [index]);
  });
  return groups;
}

function removeHistoryGroups(
  items: ResponseItem[],
  groups: number[][],
  groupCount: number,
): ResponseItem[] {
  const removedIndexes = new Set(groups.slice(0, groupCount).flat());
  return items.filter((_, index) => !removedIndexes.has(index));
}

function minimumHistoryGroupsToRemove(
  params: RemoteCompactionRequestBodyParams,
  input: ResponseItem[],
  groups: number[][],
  contextWindow: number,
): number | undefined {
  let lowerBound = 1;
  let upperBound = groups.length;
  let best: number | undefined;
  while (lowerBound <= upperBound) {
    const groupCount = Math.floor((lowerBound + upperBound) / 2);
    const candidateInput = removeHistoryGroups(input, groups, groupCount);
    if (
      estimateRemoteCompactionRequestTokens({ ...params, input: candidateInput }) <= contextWindow
    ) {
      best = groupCount;
      upperBound = groupCount - 1;
    } else {
      lowerBound = groupCount + 1;
    }
  }
  return best;
}

function largestMessageTruncationThatFits(
  params: RemoteCompactionRequestBodyParams,
  input: ResponseItem[],
  messageIndex: number,
  contextWindow: number,
): ResponseItem | undefined {
  const text = messageText(input[messageIndex]);
  if (!text || codePointLength(text) < 3) return undefined;

  let lowerBound = 2;
  let upperBound = codePointLength(text) - 1;
  let best: ResponseItem | undefined;
  while (lowerBound <= upperBound) {
    const retainedCharacters = Math.floor((lowerBound + upperBound) / 2);
    const truncated = truncateMessageText(input[messageIndex], retainedCharacters);
    if (!truncated) return undefined;
    const candidateInput = [...input];
    candidateInput[messageIndex] = truncated;
    if (
      estimateRemoteCompactionRequestTokens({ ...params, input: candidateInput }) <= contextWindow
    ) {
      best = truncated;
      lowerBound = retainedCharacters + 1;
    } else {
      upperBound = retainedCharacters - 1;
    }
  }
  return best;
}

export function budgetRemoteCompactionInput(
  params: RemoteCompactionRequestBodyParams,
): ResponseItem[] {
  const contextWindow = params.model.contextWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return params.input;

  let estimatedCharacters = approximateSerializedCharacters(
    buildRemoteCompactionRequestBody(params),
  );
  let estimatedTokens = approximateTokensFromCharacters(estimatedCharacters);
  if (estimatedTokens <= contextWindow) return params.input;

  let input = params.input.map(cloneResponseItem);
  for (let index = 0; index < input.length && estimatedTokens > contextWindow; index++) {
    const rewritten = rewrittenOutputForContextWindow(input[index]);
    if (!rewritten) continue;
    const currentCharacters = approximateSerializedCharacters(input[index]);
    const rewrittenCharacters = approximateSerializedCharacters(rewritten);
    if (rewrittenCharacters >= currentCharacters) continue;
    input[index] = rewritten;
    estimatedCharacters -= currentCharacters - rewrittenCharacters;
    estimatedTokens = approximateTokensFromCharacters(estimatedCharacters);
  }

  if (estimatedTokens <= contextWindow) return input;

  const groups = removableHistoryGroups(input);
  const groupsToRemove = minimumHistoryGroupsToRemove(params, input, groups, contextWindow);
  if (groupsToRemove !== undefined) {
    const boundaryGroup = groups[groupsToRemove - 1];
    if (boundaryGroup.length === 1 && input[boundaryGroup[0]].type === "message") {
      const inputBeforeBoundary = removeHistoryGroups(input, groups, groupsToRemove - 1);
      const removedBeforeBoundary = groups
        .slice(0, groupsToRemove - 1)
        .flat()
        .filter((index) => index < boundaryGroup[0]).length;
      const boundaryIndex = boundaryGroup[0] - removedBeforeBoundary;
      const truncated = largestMessageTruncationThatFits(
        params,
        inputBeforeBoundary,
        boundaryIndex,
        contextWindow,
      );
      if (truncated) {
        inputBeforeBoundary[boundaryIndex] = truncated;
        const normalized = normalizeResponseItemsForPrompt(inputBeforeBoundary, params.model);
        if (
          estimateRemoteCompactionRequestTokens({ ...params, input: normalized }) <= contextWindow
        ) {
          return normalized;
        }
      }
    }

    const normalized = normalizeResponseItemsForPrompt(
      removeHistoryGroups(input, groups, groupsToRemove),
      params.model,
    );
    if (estimateRemoteCompactionRequestTokens({ ...params, input: normalized }) <= contextWindow) {
      return normalized;
    }
  }

  throw new Error(
    `OpenAI remote compaction request cannot fit the ${contextWindow}-token model context window.`,
  );
}

type RemoteCompactionV2Events = {
  compactionItem: ResponseItem;
  usage?: unknown;
  serviceTier?: string;
};

type RemoteCompactionRequestParams = RemoteCompactionRequestBodyParams & {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
  signal?: AbortSignal;
  onRetry?: (retry: RemoteCompactionRetry) => void;
};

function parseSseBlock(block: string): unknown[] {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return [];
  try {
    return [JSON.parse(data) as unknown];
  } catch {
    return [];
  }
}

function normalizeSseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function parseSseData(text: string): unknown[] {
  return normalizeSseNewlines(text)
    .split("\n\n")
    .flatMap(parseSseBlock);
}

function parseRetryDelayMs(code: unknown, message: unknown): number | undefined {
  if (code !== "rate_limit_exceeded" || typeof message !== "string") return undefined;
  const match = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)/i.exec(message);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return match[2].toLowerCase() === "ms" ? value : value * 1_000;
}

const FATAL_REMOTE_COMPACTION_ERROR_CODES = new Set([
  "bio_policy",
  "context_length_exceeded",
  "cyber_policy",
  "insufficient_quota",
  "invalid_prompt",
  "server_is_overloaded",
  "slow_down",
  "usage_limit_reached",
  "usage_not_included",
]);

function isRetryableApiErrorCode(code: unknown): boolean {
  return typeof code !== "string" || !FATAL_REMOTE_COMPACTION_ERROR_CODES.has(code);
}

function responseFailedError(event: Record<string, unknown>): RemoteCompactionRequestError {
  const response = isRecord(event.response) ? event.response : undefined;
  const error = response && isRecord(response.error) ? response.error : undefined;
  const code = error?.code;
  const message = typeof error?.message === "string" ? error.message : "Response failed";
  return new RemoteCompactionRequestError(
    `OpenAI remote compaction v2 failed: ${message}`,
    isRetryableApiErrorCode(code),
    parseRetryDelayMs(code, message),
  );
}

export function parseRemoteCompactionV2Events(events: unknown[]): RemoteCompactionV2Events {
  let completed = false;
  let usage: unknown;
  let serviceTier: string | undefined;
  const compactionItems: ResponseItem[] = [];

  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      const message = typeof event.message === "string" ? event.message : "Unknown Responses API error";
      throw new RemoteCompactionRequestError(
        `OpenAI remote compaction v2 failed: ${message}`,
        isRetryableApiErrorCode(event.code),
        parseRetryDelayMs(event.code, message),
      );
    }
    if (event.type === "response.failed") {
      throw responseFailedError(event);
    }
    if (event.type === "response.incomplete") {
      const response = isRecord(event.response) ? event.response : undefined;
      const details = response && isRecord(response.incomplete_details)
        ? response.incomplete_details
        : undefined;
      const reason = typeof details?.reason === "string" ? details.reason : "unknown";
      throw new RemoteCompactionRequestError(
        `OpenAI remote compaction v2 returned an incomplete response: ${reason}`,
        true,
      );
    }
    if (
      event.type === "response.output_item.done" &&
      isRecord(event.item) &&
      event.item.type === "compaction"
    ) {
      if (!isCompactionItem(event.item)) {
        throw new RemoteCompactionRequestError(
          "OpenAI remote compaction v2 returned an invalid compaction item.",
          false,
        );
      }
      compactionItems.push(event.item);
      continue;
    }
    if (event.type === "response.completed") {
      completed = true;
      const response = isRecord(event.response) ? event.response : undefined;
      usage = response?.usage;
      serviceTier = typeof response?.service_tier === "string"
        ? response.service_tier
        : undefined;
    }
  }

  if (!completed) {
    throw new RemoteCompactionRequestError(
      "OpenAI remote compaction v2 stream ended before response.completed.",
      true,
    );
  }
  if (compactionItems.length !== 1) {
    throw new RemoteCompactionRequestError(
      `OpenAI remote compaction v2 expected exactly one compaction item, got ${compactionItems.length}.`,
      false,
    );
  }
  return { compactionItem: compactionItems[0], usage, serviceTier };
}

function abortError(): Error {
  return new DOMException("This operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

async function abortableDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      reject(signal?.reason instanceof Error ? signal.reason : abortError());
    });
    const timer = setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function retryBackoffMs(retry: number): number {
  const base = REMOTE_COMPACTION_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retry - 1);
  const jitter = 0.9 + Math.random() * 0.2;
  return Math.floor(base * jitter);
}

function asRemoteCompactionError(
  error: unknown,
  signal: AbortSignal | undefined,
): RemoteCompactionRequestError {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
  if (error instanceof RemoteCompactionRequestError) return error;
  if (error instanceof Error && error.name === "AbortError") throw error;
  const message = error instanceof Error ? error.message : String(error);
  return new RemoteCompactionRequestError(`OpenAI remote compaction v2 failed: ${message}`, true);
}

function parseHttpErrorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
    return typeof parsed.error.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

function isRetryableHttpFailure(status: number, text: string): boolean {
  if (status === 400 || status === 429) return false;
  return isRetryableApiErrorCode(parseHttpErrorCode(text));
}

function isTerminalResponseEvent(value: unknown): boolean {
  return isRecord(value) && (
    value.type === "error" ||
    value.type === "response.completed" ||
    value.type === "response.failed" ||
    value.type === "response.incomplete"
  );
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfAborted(signal);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      void reader.cancel().catch(() => {});
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : abortError()));
    };
    const idleTimer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      finish(() => reject(new RemoteCompactionRequestError(
        "OpenAI remote compaction v2 stream idle timeout.",
        true,
      )));
    }, REMOTE_COMPACTION_STREAM_IDLE_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    reader.read().then(
      (chunk) => finish(() => resolve(chunk)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function readResponseText(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const chunk = await readStreamChunk(reader, signal);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readRemoteCompactionEvents(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  if (!response.body) {
    throw new RemoteCompactionRequestError("OpenAI remote compaction v2 returned an empty stream.", true);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";
  let skipLeadingLineFeed = false;

  const appendDecoded = (decoded: string, final = false) => {
    if (skipLeadingLineFeed && (decoded.length > 0 || final)) {
      if (decoded.startsWith("\n")) decoded = decoded.slice(1);
      skipLeadingLineFeed = false;
    }
    const endedWithCarriageReturn = !final && decoded.endsWith("\r");
    if (endedWithCarriageReturn) {
      decoded = decoded.slice(0, -1);
      skipLeadingLineFeed = true;
    }
    buffer += normalizeSseNewlines(decoded);
    if (endedWithCarriageReturn) buffer += "\n";
  };

  try {
    while (true) {
      const chunk = await readStreamChunk(reader, signal);
      if (chunk.done) break;

      appendDecoded(decoder.decode(chunk.value, { stream: true }));
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const parsed = parseSseBlock(buffer.slice(0, boundary));
        events.push(...parsed);
        buffer = buffer.slice(boundary + 2);
        if (parsed.some(isTerminalResponseEvent)) {
          await reader.cancel().catch(() => {});
          return events;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    appendDecoded(decoder.decode(), true);
    events.push(...parseSseData(buffer));
    return events;
  } finally {
    reader.releaseLock();
  }
}

async function callRemoteCompactionAttempt(
  params: RemoteCompactionRequestParams,
): Promise<RemoteCompactionResult> {
  throwIfAborted(params.signal);
  let response: Response;
  try {
    response = await fetch(remoteCompactionV2EndpointUrl(params.model, params.baseUrl), {
      method: "POST",
      headers: buildRemoteCompactionHeaders({
        model: params.model,
        apiKey: params.apiKey,
        headers: params.headers,
        sessionId: params.sessionId,
      }),
      body: JSON.stringify(buildRemoteCompactionRequestBody({
        model: params.model,
        input: params.input,
        instructions: params.instructions,
        tools: params.tools,
        parallelToolCalls: params.parallelToolCalls,
        reasoning: params.reasoning,
        text: params.text,
        serviceTier: params.serviceTier,
        sessionId: params.sessionId,
      })),
      signal: params.signal,
    });
  } catch (error) {
    throw asRemoteCompactionError(error, params.signal);
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await readResponseText(response, params.signal);
    } catch (error) {
      throw asRemoteCompactionError(error, params.signal);
    }
    throw new RemoteCompactionRequestError(
      `OpenAI remote compaction v2 failed (${response.status}): ${text || response.statusText}`,
      isRetryableHttpFailure(response.status, text),
    );
  }

  const parsed = parseRemoteCompactionV2Events(
    await readRemoteCompactionEvents(response, params.signal),
  );
  return {
    output: buildRemoteCompactionV2History(params.input, parsed.compactionItem),
    usage: extractRemoteCompactionUsage(
      params.model,
      parsed.usage,
      parsed.serviceTier ?? params.serviceTier,
    ),
  };
}

export async function callRemoteCompactionEndpoint(
  params: RemoteCompactionRequestParams,
): Promise<RemoteCompactionResult> {
  throwIfAborted(params.signal);
  const budgetedInput = budgetRemoteCompactionInput(params);
  const requestParams = budgetedInput === params.input
    ? params
    : { ...params, input: budgetedInput };
  let retries = 0;
  while (true) {
    try {
      return await callRemoteCompactionAttempt(requestParams);
    } catch (error) {
      const remoteError = asRemoteCompactionError(error, requestParams.signal);
      if (!remoteError.retryable || retries >= MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES) {
        throw remoteError;
      }
      retries += 1;
      const delayMs = remoteError.retryDelayMs ?? retryBackoffMs(retries);
      requestParams.onRetry?.({
        attempt: retries,
        maxRetries: MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES,
        delayMs,
        error: remoteError,
      });
      await abortableDelay(delayMs, requestParams.signal);
    }
  }
}

export function buildRemoteCompactionDetails(
  model: Model<any>,
  replacementHistory: ResponseItem[],
  usage?: RemoteCompactionUsageSnapshot,
): RemoteCompactionDetails {
  return {
    version: 2,
    provider: "openai-responses-compaction",
    implementation: "responses_compaction_v2",
    modelKey: modelKey(model),
    replacementHistory,
    ...(usage ? { usage } : {}),
  };
}

export function extractRemoteCompactionDetails(details: unknown):
  | RemoteCompactionDetails
  | undefined {
  if (!isRecord(details)) return undefined;

  const remote = isRecord(details.remoteCompaction) ? details.remoteCompaction : details;
  if (!isRecord(remote)) return undefined;
  const isLegacy = remote.provider === "openai-responses-compact" && remote.version === 1;
  const isV2 = remote.provider === "openai-responses-compaction" && remote.version === 2;
  if (!isLegacy && !isV2) return undefined;
  if (typeof remote.modelKey !== "string" || !remote.modelKey.trim()) return undefined;
  if (!Array.isArray(remote.replacementHistory) || remote.replacementHistory.length === 0) {
    return undefined;
  }
  if (!remote.replacementHistory.every(isResponseItem)) return undefined;
  if (!remote.replacementHistory.some(isCompactionItem)) return undefined;

  const replacementHistory = remote.replacementHistory;
  const usage = parseRemoteCompactionUsageSnapshot(remote.usage);

  return {
    version: isV2 ? 2 : 1,
    provider: isV2 ? "openai-responses-compaction" : "openai-responses-compact",
    implementation: isV2 ? "responses_compaction_v2" : "responses_compact_v1",
    modelKey: remote.modelKey,
    replacementHistory,
    ...(usage ? { usage } : {}),
  };
}

export function reconstructRemoteCompactionStateFromBranch(params: {
  branchEntries: Array<{ type: string; id: string; details?: unknown; message?: AgentMessage }>;
}): RemoteCompactionSessionState | undefined {
  let latestCompactionEntryId = "";
  let latestDetails: RemoteCompactionDetails | undefined;

  for (const entry of params.branchEntries) {
    if (entry.type !== "compaction") continue;
    latestCompactionEntryId = entry.id;
    latestDetails = extractRemoteCompactionDetails(entry.details);
  }

  if (!latestDetails) return undefined;

  return {
    compactionEntryId: latestCompactionEntryId,
    modelKey: latestDetails.modelKey,
    replacementHistory: latestDetails.replacementHistory,
  };
}
