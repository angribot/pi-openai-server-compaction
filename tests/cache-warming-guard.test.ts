import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  type CacheWarmingDecisionEvent,
  type ExtensionActions,
  type ExtensionContextActions,
  type ModelRegistry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  NATIVE_REPLAY_CHECKPOINT_FORMAT,
  REMOTE_COMPACTION_CHECKPOINT_MARKER,
  type BranchEntry,
} from "../src/native-replay.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Pi 0.86 does not export the warmer from its package root; load the real
// module instance used by the host so the timer, decision, and dispatch path
// under test are Pi's, not a re-implementation.
const cacheWarmerUrl = new URL(
  "core/cache-warmer.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);

type CacheWarmerAction = "warm" | "stop";
type CacheWarmerInstance = {
  start(
    request: { model: Model<any>; context: unknown; options: Record<string, unknown> },
    isCurrent: () => boolean,
  ): void;
  cancel(): void;
  readonly status: { state: string; reason?: string; extensionOverride?: boolean };
};
type CacheWarmerConstructor = new (
  models: { streamSimple(...args: unknown[]): { result(): Promise<unknown> } },
  sessionManager: { getBranch(): BranchEntry[]; appendUsage(...args: unknown[]): unknown },
  getMode: () => "streaming",
  decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmerAction>,
) => CacheWarmerInstance;

type Harness = {
  runner: ExtensionRunner;
  session: {
    branch: BranchEntry[];
    getBranch(): BranchEntry[];
    appendUsage(): unknown;
  };
  aborts(): number;
};

let harnessPromise: Promise<Harness> | undefined;
let cleanup: (() => Promise<void>) | undefined;

after(async () => {
  await cleanup?.();
});

function loadHarness(): Promise<Harness> {
  harnessPromise ??= (async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-remote-compaction-warming-"));
    const cwd = join(isolatedRoot, "cwd");
    const agentDir = join(isolatedRoot, "agent");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

    const result = await discoverAndLoadExtensions([join(repoRoot, "index.ts")], cwd, agentDir);
    assert.deepEqual(result.errors, []);

    const session = {
      branch: [] as BranchEntry[],
      getBranch() {
        return session.branch;
      },
      appendUsage() {
        return { type: "usage", id: "warming-usage", timestamp: new Date().toISOString() };
      },
    };
    let aborts = 0;
    const runner = new ExtensionRunner(
      result.extensions,
      result.runtime,
      cwd,
      session as unknown as SessionManager,
      {} as unknown as ModelRegistry,
    );
    runner.bindCore({} as ExtensionActions, {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => false,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {
        aborts++;
      },
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    } satisfies ExtensionContextActions);

    cleanup = () => rm(isolatedRoot, { recursive: true, force: true });
    return { runner, session, aborts: () => aborts };
  })();
  return harnessPromise;
}

async function decide(harness: Harness, hostAction: CacheWarmerAction): Promise<CacheWarmerAction> {
  return harness.runner.emitCacheWarmingDecision({
    type: "cache_warming_decision",
    warmCost: 1,
    missCost: 2,
    continuationProbability: 1,
    action: hostAction,
  });
}

function userEntry(id: string): BranchEntry {
  return {
    type: "message",
    id,
    parentId: null,
    message: { role: "user", content: "hello", timestamp: 1 },
  };
}

function assistantEntry(id: string, promptTokens = 1_000_000, modelId = "gpt-5.4"): BranchEntry {
  return {
    type: "message",
    id,
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "example-provider",
      model: modelId,
      usage: {
        input: promptTokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: promptTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  };
}

function compactionEntry(id: string, summary: unknown, details?: unknown): BranchEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    summary,
    firstKeptEntryId: "u1",
    tokensBefore: 10,
    details,
  };
}

function nativeDetails(options: { modelId?: string; compatibilityClass?: string | null } = {}) {
  return {
    nativeReplayCheckpoint: {
      format: NATIVE_REPLAY_CHECKPOINT_FORMAT,
      producer: {
        modelKey: {
          provider: "example-provider",
          api: "openai-responses",
          id: options.modelId ?? "gpt-5.4",
        },
        compactionCompatibilityClass:
          options.compatibilityClass === undefined ? "3000" : options.compatibilityClass,
      },
      replacementHistory: [{ type: "compaction", encrypted_content: "opaque-item" }],
    },
  };
}

const LEGACY_DETAILS = {
  remoteCompaction: {
    version: 2,
    modelKey: { provider: "example-provider", api: "openai-responses", id: "gpt-5.4" },
    replacementHistory: [{ type: "compaction", encrypted_content: "opaque-item" }],
  },
};

function checkpointBranch(
  details: unknown = nativeDetails(),
  suffix: BranchEntry[] = [assistantEntry("a1")],
): BranchEntry[] {
  return [
    userEntry("u1"),
    ...suffix,
    compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, details),
  ];
}

test("every active Remote compaction checkpoint state stops warming regardless of host decision", async () => {
  const harness = await loadHarness();
  const ordinary = compactionEntry("c9", "portable summary", {});
  const checkpoint = checkpointBranch();

  const cases: Array<[string, BranchEntry[], boolean]> = [
    ["native checkpoint", checkpoint, true],
    [
      "native checkpoint with a null compatibility class",
      checkpointBranch(nativeDetails({ compatibilityClass: null })),
      true,
    ],
    [
      "checkpoint produced by a different model key",
      checkpointBranch(nativeDetails({ modelId: "gpt-other" })),
      true,
    ],
    [
      "checkpoint invalidated by a successful incompatible turn",
      [...checkpoint, assistantEntry("a2", 1_000_000, "gpt-other")],
      true,
    ],
    ["malformed checkpoint details", checkpointBranch({}), true],
    [
      "checkpoint without details",
      [userEntry("u1"), compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER)],
      true,
    ],
    ["legacy remoteCompaction checkpoint", checkpointBranch(LEGACY_DETAILS), true],
    ["ordinary compaction", [userEntry("u1"), ordinary], false],
    ["checkpoint superseded by later ordinary compaction", [...checkpoint, ordinary], false],
    ["no compaction", [userEntry("u1"), assistantEntry("a1")], false],
    ["empty branch", [], false],
  ];

  for (const [name, branch, protectedCheckpoint] of cases) {
    harness.session.branch = branch;
    for (const hostAction of ["warm", "stop"] as const) {
      const expected: CacheWarmerAction = protectedCheckpoint ? "stop" : hostAction;
      assert.equal(
        await decide(harness, hostAction),
        expected,
        `${name} with host "${hostAction}"`,
      );
    }
  }

  assert.equal(harness.aborts(), 0, "the decision must not abort the main run");
});

test("each decision follows the current branch without stale suppression", async () => {
  const harness = await loadHarness();
  const checkpoint = checkpointBranch();
  const superseded = [...checkpoint, compactionEntry("c2", "portable summary", {})];

  harness.session.branch = checkpoint;
  assert.equal(await decide(harness, "warm"), "stop");

  harness.session.branch = superseded;
  assert.equal(await decide(harness, "warm"), "warm", "ordinary compaction lifts protection");

  harness.session.branch = [];
  assert.equal(await decide(harness, "warm"), "warm", "branch navigation lifts protection");

  harness.session.branch = checkpoint;
  assert.equal(await decide(harness, "warm"), "stop", "a restored checkpoint protects again");
});

test("Pi 0.86's real CacheWarmer stops before transport and leaves its own decisions unchanged", async () => {
  const harness = await loadHarness();
  const { CacheWarmer } = (await import(cacheWarmerUrl.href)) as {
    CacheWarmer: CacheWarmerConstructor;
  };

  const warmedMessage = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "example-provider",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 1,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      totalTokens: 1_000_001,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  async function runWarmer(branch: BranchEntry[]) {
    harness.session.branch = branch;
    const abortsBefore = harness.aborts();
    let streamSimpleCalls = 0;
    let decisions = 0;
    const warmer = new CacheWarmer(
      {
        streamSimple() {
          streamSimpleCalls++;
          return { result: async () => warmedMessage };
        },
      },
      harness.session,
      () => "streaming",
      (event) => {
        decisions++;
        return harness.runner.emitCacheWarmingDecision(event);
      },
    );
    warmer.start({ model: warmingModel(), context: {}, options: {} }, () => true);

    // A run may stop before dispatch once its decision runs (protected
    // checkpoint) or its expected savings are too low. Wait for either the
    // transport or an observed, settled decision rather than the status getter,
    // which reports "inactive" for an unevaluated cold run.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && streamSimpleCalls === 0) {
      if (decisions > 0 && warmer.status.state === "inactive") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const outcome = {
      streamSimpleCalls,
      decisions,
      aborts: harness.aborts() - abortsBefore,
      status: warmer.status,
    };
    warmer.cancel();
    return outcome;
  }

  const protectedRun = await runWarmer([
    userEntry("u1"),
    assistantEntry("a1"),
    compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, nativeDetails()),
  ]);
  assert.ok(protectedRun.decisions >= 1, "the protected decision must run");
  assert.equal(protectedRun.streamSimpleCalls, 0, "the protected refresh must not reach transport");
  assert.equal(protectedRun.aborts, 0, "the protected refresh must not abort the main run");
  assert.equal(protectedRun.status.state, "inactive");
  assert.equal(protectedRun.status.extensionOverride, true, "the guard stopped the refresh");

  const warmRun = await runWarmer([userEntry("u1"), assistantEntry("a1")]);
  assert.ok(warmRun.decisions >= 1, "the ordinary decision must run");
  assert.equal(warmRun.streamSimpleCalls, 1, "ordinary warming still reaches the provider");
  assert.equal(warmRun.aborts, 0);

  // A successful turn with tiny prompt usage makes Pi's own economics decide
  // "stop"; the extension must leave that decision unchanged and still not
  // abort the main run.
  const hostStopRun = await runWarmer([userEntry("u1"), assistantEntry("a1", 1)]);
  assert.ok(hostStopRun.decisions >= 1, "the host-stop decision must run");
  assert.equal(hostStopRun.streamSimpleCalls, 0, "Pi's own stop must not reach transport");
  assert.equal(hostStopRun.status.state, "inactive");
  assert.equal(hostStopRun.status.extensionOverride, false, "no extension override was applied");
  assert.equal(hostStopRun.aborts, 0);
});

function warmingModel(): Model<any> {
  return {
    provider: "example-provider",
    api: "openai-responses",
    id: "gpt-5.4",
    name: "Cache warming test model",
    baseUrl: "https://model.example/v1/",
    reasoning: false,
    input: ["text"],
    cost: { input: 10, output: 100, cacheRead: 1, cacheWrite: 12.5 },
    promptCache: { short: 10.05, long: 10.05 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  };
}
