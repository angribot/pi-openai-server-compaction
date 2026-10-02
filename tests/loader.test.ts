import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("the production extension loader installs only the Remote compaction protocol hooks", async () => {
  const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-remote-compaction-loader-"));
  const cwd = join(isolatedRoot, "cwd");
  const agentDir = join(isolatedRoot, "agent");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

  try {
    const loadedModule = await import(pathToFileURL(join(repoRoot, "index.ts")).href);
    assert.equal(typeof loadedModule.default, "function");

    const result = await discoverAndLoadExtensions([join(repoRoot, "index.ts")], cwd, agentDir);

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);

    const [extension] = result.extensions;
    assert.ok(extension);
    assert.deepEqual([...extension.handlers.keys()].sort(), [
      "before_provider_request",
      "cache_warming_decision",
      "session_before_compact",
    ]);
    assert.equal(extension.tools.size, 0);
    assert.deepEqual(result.runtime.pendingProviderRegistrations, []);

    // Exercise conversion through the host's module aliases, not a direct TS import.
    const notifications: string[] = [];
    let reachedAuth = false;
    const branch = [{
      type: "message", id: "u1", parentId: null,
      message: { role: "user", content: "compact me", timestamp: 1 },
    }];
    const handler = extension.handlers.get("session_before_compact")![0]!;
    await handler({
      type: "session_before_compact",
      preparation: { firstKeptEntryId: "u1", tokensBefore: 42 },
      branchEntries: branch, reason: "manual", willRetry: false,
      signal: new AbortController().signal,
    } as never, {
      model: {
        provider: "openai", api: "openai-responses", id: "gpt-6.1-sol",
        input: ["text"], contextWindow: 100_000, maxTokens: 4096,
      },
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
      getSystemPrompt: () => "Be concise.",
      sessionManager: { getBranch: () => branch, getSessionId: () => "loader-probe" },
      modelRegistry: {
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => {
          reachedAuth = true;
          return { ok: false, error: "Intentional stop before network" };
        },
      },
    } as never);
    assert.ok(reachedAuth, notifications.join("\n"));
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});
