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
type ToolResultOutputItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

type ContentPartLike = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  source?: unknown;
};

export type ResponseContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string; annotations?: unknown[] };

export type ResponseItem =
  | {
      type: "message";
      role: string;
      content: ResponseContentItem[];
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
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "concise" | "detailed" | null;
};

export type ResponsesTextConfig = Record<string, unknown>;

export type RemoteCompactionUsageSnapshot = Usage;

const IMAGE_CONTENT_OMITTED_PLACEHOLDER = "image content omitted because you do not support image input";
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
  explicitHistory: ResponseItem[];
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

function contentToResponseContentItems(content: unknown): ResponseContentItem[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: sanitizeSurrogates(content) }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: ResponseContentItem[] = [];
  for (const part of content as ContentPartLike[]) {
    if (
      (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      items.push({ type: "input_text", text: sanitizeSurrogates(part.text) });
      continue;
    }
    if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      items.push({ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` });
      continue;
    }
    if (
      part.type === "input_image" &&
      part.source &&
      typeof part.source === "object" &&
      (part.source as { type?: unknown }).type === "url" &&
      typeof (part.source as { url?: unknown }).url === "string"
    ) {
      items.push({ type: "input_image", image_url: (part.source as { url: string }).url });
    }
  }
  return items;
}

function toolResultContentToOutput(
  content: unknown,
  model?: { input?: readonly unknown[] },
): string | ToolResultOutputItem[] {
  if (typeof content === "string") return sanitizeSurrogates(content);
  if (!Array.isArray(content)) return "(no tool output)";

  const textParts: string[] = [];
  const images: ContentPartLike[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as ContentPartLike;
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(sanitizeSurrogates(part.text));
    } else if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    ) {
      images.push(part);
    }
  }
  const text = textParts.join("\n");

  if (images.length === 0 || !modelSupportsImageInput(model ?? {})) {
    return text || (images.length > 0 ? "(see attached image)" : "(no tool output)");
  }

  return [
    ...(text ? [{ type: "input_text" as const, text }] : []),
    ...images.map((image) => ({
      type: "input_image" as const,
      image_url: `data:${image.mimeType};base64,${image.data}`,
    })),
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
    const content = contentToResponseContentItems(message.content);
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
      ? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER }
      : item
  ));
}

function stripUnsupportedFunctionOutputImages(output: unknown): unknown {
  if (Array.isArray(output)) {
    return output.map((item) => (
      isRecord(item) && item.type === "input_image"
        ? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER }
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
  if (item.type !== "message" || !Array.isArray(item.content)) return "";
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
  if (item.type !== "message" || !Array.isArray(item.content)) return cloneResponseItem(item);
  let remainingCharacters = Math.max(0, maxTokens * 4);
  const content = item.content.flatMap((part) => {
    if (part.type === "input_image") return [part];
    if (remainingCharacters === 0) return [];
    const text = part.text.slice(0, remainingCharacters);
    remainingCharacters -= text.length;
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

function extractRemoteCompactionUsage(model: Model<any>, value: unknown): RemoteCompactionUsageSnapshot | undefined {
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

export function buildRemoteCompactionRequestBody(params: {
  model: Model<any>;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  parallelToolCalls: boolean;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  serviceTier?: string;
  sessionId?: string;
}): Record<string, unknown> {
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

type RemoteCompactionV2Events = {
  compactionItem: ResponseItem;
  usage?: unknown;
};

type RemoteCompactionRequestParams = {
  model: Model<any>;
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
  sessionId?: string;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  parallelToolCalls: boolean;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  serviceTier?: string;
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
  return { compactionItem: compactionItems[0], usage };
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
    usage: extractRemoteCompactionUsage(params.model, parsed.usage),
  };
}

export async function callRemoteCompactionEndpoint(
  params: RemoteCompactionRequestParams,
): Promise<RemoteCompactionResult> {
  let retries = 0;
  while (true) {
    try {
      return await callRemoteCompactionAttempt(params);
    } catch (error) {
      const remoteError = asRemoteCompactionError(error, params.signal);
      if (!remoteError.retryable || retries >= MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES) {
        throw remoteError;
      }
      retries += 1;
      const delayMs = remoteError.retryDelayMs ?? retryBackoffMs(retries);
      params.onRetry?.({
        attempt: retries,
        maxRetries: MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES,
        delayMs,
        error: remoteError,
      });
      await abortableDelay(delayMs, params.signal);
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

function assistantMessageMatchesModelKey(
  message: Extract<AgentMessage, { role: "assistant" }>,
  targetModelKey: string,
): boolean {
  return modelKey({
    provider: message.provider,
    api: message.api,
    id: message.model,
  }) === targetModelKey;
}

export function reconstructRemoteCompactionStateFromBranch(params: {
  branchEntries: Array<{ type: string; id: string; details?: unknown; message?: AgentMessage }>;
}): RemoteCompactionSessionState | undefined {
  let latestCompactionIndex = -1;
  let latestCompactionEntryId = "";
  let latestDetails: RemoteCompactionDetails | undefined;

  params.branchEntries.forEach((entry, index) => {
    if (entry.type !== "compaction") return;
    latestCompactionIndex = index;
    latestCompactionEntryId = entry.id;
    latestDetails = extractRemoteCompactionDetails(entry.details);
  });

  if (!latestDetails || latestCompactionIndex < 0) return undefined;

  const trailingMessages: ResponseItem[] = [];
  let pendingTurnItems: ResponseItem[] = [];

  for (const entry of params.branchEntries.slice(latestCompactionIndex + 1)) {
    if (entry.type !== "message" || !entry.message) continue;

    const items = messageToResponseItems(entry.message);
    if (items.length === 0) continue;

    if (entry.message.role === "assistant") {
      if (assistantMessageMatchesModelKey(entry.message, latestDetails.modelKey)) {
        trailingMessages.push(...pendingTurnItems, ...items);
      }
      pendingTurnItems = [];
      continue;
    }

    pendingTurnItems.push(...items);
  }

  return {
    compactionEntryId: latestCompactionEntryId,
    modelKey: latestDetails.modelKey,
    replacementHistory: latestDetails.replacementHistory,
    explicitHistory: [...latestDetails.replacementHistory, ...trailingMessages],
  };
}
