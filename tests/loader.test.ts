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
      "session_before_compact",
    ]);
    assert.equal(extension.tools.size, 0);
    assert.deepEqual(result.runtime.pendingProviderRegistrations, []);
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});
