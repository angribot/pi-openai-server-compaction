/**
 * OpenAI Responses model and payload helpers.
 *
 * Remote compaction is provider-agnostic and applies only to the plain
 * `openai-responses` API. Transport selection belongs to a separate extension.
 */
import type { ResponsesReasoningConfig, ResponsesTextConfig } from "./remote-compaction.ts";

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ModelLike = {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
  baseUrl?: unknown;
  reasoning?: unknown;
  input?: readonly unknown[];
};

export function hostnameFromBaseUrl(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function supportsRemoteCompactionModel(model: unknown): model is ModelLike {
  return isRecord(model) && model.api === "openai-responses";
}

export function looksLikeResponsesPayload(payload: JsonRecord): boolean {
  return "input" in payload || "model" in payload || "messages" in payload;
}

export function modelKey(model: ModelLike): string {
  return `${String(model.provider)}:${String(model.api)}:${String(model.id)}`;
}

export function thinkingLevelToResponsesReasoning(
  thinkingLevel: unknown,
): ResponsesReasoningConfig | undefined {
  if (thinkingLevel === "minimal") return { effort: "minimal", summary: "auto" };
  if (thinkingLevel === "low") return { effort: "low", summary: "auto" };
  if (thinkingLevel === "medium") return { effort: "medium", summary: "auto" };
  if (thinkingLevel === "high") return { effort: "high", summary: "auto" };
  if (thinkingLevel === "xhigh") return { effort: "xhigh", summary: "auto" };
  return undefined;
}

export function applyRemoteHistoryPayloadPatch(params: {
  payload: JsonRecord;
  explicitHistory: unknown[];
}): JsonRecord {
  const nextPayload: JsonRecord = {
    ...params.payload,
    input: params.explicitHistory,
  };
  delete nextPayload.messages;
  delete nextPayload.previous_response_id;
  return nextPayload;
}

export function extractResponsesReasoningConfig(payload: unknown): ResponsesReasoningConfig | undefined {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return undefined;
  const effort = payload.reasoning.effort;
  const summary = payload.reasoning.summary;
  const normalized: ResponsesReasoningConfig = {
    ...(typeof effort === "string" ? { effort: effort as ResponsesReasoningConfig["effort"] } : {}),
    ...(
      summary === null || typeof summary === "string"
        ? { summary: summary as ResponsesReasoningConfig["summary"] }
        : {}
    ),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function extractResponsesTextConfig(payload: unknown): ResponsesTextConfig | undefined {
  return isRecord(payload) && isRecord(payload.text) ? payload.text : undefined;
}

export function extractResponsesServiceTier(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.service_tier === "string"
    ? payload.service_tier
    : undefined;
}

export function messageMatchesModel(message: unknown, model: ModelLike): boolean {
  if (!isRecord(message)) return false;
  return message.provider === model.provider &&
    message.api === model.api &&
    message.model === model.id;
}
