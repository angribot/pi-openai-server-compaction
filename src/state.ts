/**
 * In-memory per-session runtime state.
 *
 * Persisted remote compaction artifacts live in Pi session entries; this module
 * only caches reconstructed replay state and the latest Responses request shape.
 */
import type {
  RemoteCompactionSessionState,
  ResponsesReasoningConfig,
  ResponsesTextConfig,
} from "./remote-compaction.ts";

export type ResponsesRequestShapeState = {
  updatedAt: number;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
};

const remoteCompactionBySessionId = new Map<string, RemoteCompactionSessionState>();
const requestShapeBySessionId = new Map<string, ResponsesRequestShapeState>();

export function getRemoteCompactionState(
  sessionId: string,
): RemoteCompactionSessionState | undefined {
  return remoteCompactionBySessionId.get(sessionId);
}

export function setRemoteCompactionState(
  sessionId: string,
  state: RemoteCompactionSessionState,
): void {
  remoteCompactionBySessionId.set(sessionId, state);
}

export function clearRemoteCompactionState(sessionId: string | undefined): void {
  if (!sessionId) return;
  remoteCompactionBySessionId.delete(sessionId);
}

export function getResponsesRequestShapeState(
  sessionId: string,
): ResponsesRequestShapeState | undefined {
  return requestShapeBySessionId.get(sessionId);
}

export function setResponsesRequestShapeState(
  sessionId: string,
  state: ResponsesRequestShapeState,
): void {
  requestShapeBySessionId.set(sessionId, state);
}

export function clearResponsesRequestShapeState(sessionId: string | undefined): void {
  if (!sessionId) return;
  requestShapeBySessionId.delete(sessionId);
}

export function clearAllRuntimeState(): void {
  remoteCompactionBySessionId.clear();
  requestShapeBySessionId.clear();
}
