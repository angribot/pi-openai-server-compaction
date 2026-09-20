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

function assistantEntry(id: string, modelId = "gpt-5.4"): BranchEntry {
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
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1_000_000,
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

test("every active Remote compaction checkpoint state stops warming regardless of host decision", async () => {
  const harness = await loadHarness();
  const ordinary = compactionEntry("c9", "portable summary", {});
  const checkpoint = compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, nativeDetails());

  const cases: Array<[string, BranchEntry[], boolean]> = [
    ["native checkpoint", [userEntry("u1"), checkpoint], true],
    [
      "native checkpoint with a null compatibility class",
      [
        userEntry("u1"),
        compactionEntry(
          "c1",
          REMOTE_COMPACTION_CHECKPOINT_MARKER,
          nativeDetails({ compatibilityClass: null }),
        ),
      ],
      true,
    ],
    [
      "checkpoint produced by a different model key",
      [
        userEntry("u1"),
        compactionEntry(
          "c1",
          REMOTE_COMPACTION_CHECKPOINT_MARKER,
          nativeDetails({ modelId: "gpt-other" }),
        ),
      ],
      true,
    ],
    [
      "checkpoint invalidated by a successful incompatible turn",
      [userEntry("u1"), checkpoint, assistantEntry("a1", "gpt-other")],
      true,
    ],
    [
      "malformed checkpoint details",
      [userEntry("u1"), compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, {})],
      true,
    ],
    [
      "checkpoint without details",
      [userEntry("u1"), compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER)],
      true,
    ],
    [
      "legacy remoteCompaction checkpoint",
      [userEntry("u1"), compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, LEGACY_DETAILS)],
      true,
    ],
    ["ordinary compaction", [userEntry("u1"), ordinary], false],
    [
      "checkpoint superseded by later ordinary compaction",
      [userEntry("u1"), checkpoint, ordinary],
      false,
    ],
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
  const checkpointBranch = [
    userEntry("u1"),
    compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, nativeDetails()),
  ];
  const supersededBranch = [...checkpointBranch, compactionEntry("c2", "portable summary", {})];

  harness.session.branch = checkpointBranch;
  assert.equal(await decide(harness, "warm"), "stop");

  harness.session.branch = supersededBranch;
  assert.equal(await decide(harness, "warm"), "warm", "ordinary compaction lifts protection");

  harness.session.branch = [];
  assert.equal(await decide(harness, "warm"), "warm", "branch navigation lifts protection");

  harness.session.branch = checkpointBranch;
  assert.equal(await decide(harness, "warm"), "stop", "a restored checkpoint protects again");
});

test("Pi 0.86's real CacheWarmer stops a protected refresh before provider dispatch", async () => {
  const harness = await loadHarness();
  const { CacheWarmer } = (await import(cacheWarmerUrl.href)) as {
    CacheWarmer: CacheWarmerConstructor;
  };

  const protectedBranches: Array<[string, BranchEntry[]]> = [
    [
      "valid checkpoint",
      [
        userEntry("u1"),
        assistantEntry("a1"),
        compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, nativeDetails()),
      ],
    ],
    [
      "malformed checkpoint",
      [
        userEntry("u1"),
        assistantEntry("a1"),
        compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, {}),
      ],
    ],
    [
      "incompatible checkpoint",
      [
        userEntry("u1"),
        assistantEntry("a1"),
        compactionEntry(
          "c1",
          REMOTE_COMPACTION_CHECKPOINT_MARKER,
          nativeDetails({ modelId: "gpt-other" }),
        ),
      ],
    ],
    [
      "invalidated checkpoint",
      [
        userEntry("u1"),
        assistantEntry("a1"),
        compactionEntry("c1", REMOTE_COMPACTION_CHECKPOINT_MARKER, nativeDetails()),
        assistantEntry("a2", "gpt-other"),
      ],
    ],
  ];
  // Prompt usage gives Pi's own decision a positive expected saving (warm);
  // without a successful assistant turn Pi decides to stop on its own.
  const warmableBranch = [userEntry("u1"), assistantEntry("a1")];
  const coldBranch = [userEntry("u1")];

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
    const warmer = new CacheWarmer(
      {
        streamSimple() {
          streamSimpleCalls++;
          return { result: async () => warmedMessage };
        },
      },
      harness.session,
      () => "streaming",
      (event) => harness.runner.emitCacheWarmingDecision(event),
    );
    warmer.start({ model: warmingModel(), context: {}, options: {} }, () => true);

    const deadline = Date.now() + 2_000;
    while (warmer.status.state !== "inactive" && streamSimpleCalls === 0) {
      if (Date.now() > deadline) throw new Error("cache warmer did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const outcome = {
      streamSimpleCalls,
      aborts: harness.aborts() - abortsBefore,
      status: warmer.status,
    };
    warmer.cancel();
    return outcome;
  }

  for (const [name, branch] of protectedBranches) {
    const outcome = await runWarmer(branch);
    assert.equal(outcome.streamSimpleCalls, 0, `${name}: must not reach transport`);
    assert.equal(outcome.aborts, 0, `${name}: must not abort the main run`);
    assert.equal(outcome.status.state, "inactive", name);
    assert.equal(outcome.status.extensionOverride, true, `${name}: the guard stopped the refresh`);
  }

  const warmRun = await runWarmer(warmableBranch);
  assert.equal(warmRun.streamSimpleCalls, 1, "ordinary warming still reaches the provider");
  assert.equal(warmRun.aborts, 0);

  const coldRun = await runWarmer(coldBranch);
  assert.equal(coldRun.streamSimpleCalls, 0, "Pi's own stop is left unchanged");
  assert.equal(coldRun.status.extensionOverride, undefined);
  assert.equal(coldRun.aborts, 0);
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
