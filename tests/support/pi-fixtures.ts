import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

export type Hook = (event: any, context: any) => unknown;

export type TestBranchEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: AgentMessage;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: unknown;
};

export function responsesModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    provider: "example-provider",
    api: "openai-responses",
    id: "gpt-test",
    name: "Remote compaction test model",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

export function userMessage(text: string, timestamp = 1): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

export function assistantMessage(
  text: string,
  selectedModel = responsesModel(),
  overrides: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: "assistant",
    provider: selectedModel.provider,
    api: selectedModel.api,
    model: selectedModel.id,
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
    ...overrides,
  } as AgentMessage;
}

export function chainEntries(
  entries: Array<
    Omit<TestBranchEntry, "parentId" | "timestamp"> &
      Partial<Pick<TestBranchEntry, "parentId" | "timestamp">>
  >,
): TestBranchEntry[] {
  return entries.map((entry, index) => ({
    ...entry,
    parentId: entry.parentId === undefined ? (entries[index - 1]?.id ?? null) : entry.parentId,
    timestamp: entry.timestamp ?? new Date(index * 1_000).toISOString(),
  }));
}

export function messageEntry(
  id: string,
  message: AgentMessage,
): Omit<TestBranchEntry, "parentId" | "timestamp"> {
  return { type: "message", id, message };
}

export function createRecordingPi(
  options: {
    tools?: ToolInfo[];
    activeTools?: string[];
  } = {},
): {
  pi: ExtensionAPI;
  handlers: Map<string, Hook>;
} {
  const handlers = new Map<string, Hook>();
  const pi = {
    on(name: string, handler: Hook) {
      if (handlers.has(name)) throw new Error(`duplicate handler: ${name}`);
      handlers.set(name, handler);
    },
    registerProvider() {
      throw new Error("provider registration is forbidden");
    },
    appendEntry() {
      throw new Error("appendEntry must not be called");
    },
    getAllTools() {
      return options.tools ?? [];
    },
    getActiveTools() {
      return options.activeTools ?? [];
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

export function createHookContext(options: {
  branch: TestBranchEntry[];
  model?: Model<any>;
  systemPrompt?: string;
  hasUI?: boolean;
  auth?: unknown;
}): {
  context: any;
  notifications: Array<{ message: string; level: string }>;
  abortCalls: { count: number };
} {
  const notifications: Array<{ message: string; level: string }> = [];
  const abortCalls = { count: 0 };
  const context = {
    cwd: process.cwd(),
    model: options.model ?? responsesModel(),
    hasUI: options.hasUI ?? true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return options.auth ?? { ok: true, apiKey: "sk-test" };
      },
    },
    sessionManager: {
      getBranch() {
        return options.branch;
      },
      getSessionId() {
        return "test-session";
      },
    },
    getSystemPrompt() {
      return options.systemPrompt ?? "SYSTEM";
    },
    abort() {
      abortCalls.count++;
    },
  };
  return { context, notifications, abortCalls };
}

export function compactionEvent(
  branchEntries: TestBranchEntry[],
  signal: AbortSignal = new AbortController().signal,
  customInstructions?: string,
): any {
  return {
    type: "session_before_compact",
    branchEntries,
    preparation: {
      firstKeptEntryId: branchEntries[0]?.id ?? "first",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 123,
      fileOps: { read: new Set(), modified: new Set(), created: new Set() },
      settings: {},
    },
    customInstructions,
    reason: "manual",
    willRetry: false,
    signal,
  };
}
