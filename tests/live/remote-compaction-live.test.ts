import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveCodexCompactionCompatibilityClass } from "../../src/remote-compaction.ts";

const selectedModel = process.env.PI_OPENAI_SERVER_COMPACTION_TEST_MODEL;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(repoRoot, "index.ts");
const checkpointMarker =
  "[Remote Responses compaction checkpoint]\n\n" +
  "Detailed context before this checkpoint is retained in the native replay artifact and is available only to compatible Responses models.";
const checkpointFormat = "native-replay-checkpoint/1";
const compatibilityDecisionType = "native-replay-compatibility-decision/1";
// Pi estimates text at four chars per token; this exceeds its default 20K retained suffix.
const paddingBeyondDefaultRetainedSuffix = "remote-compaction-live-context ".repeat(5_000);

type JsonRecord = Record<string, unknown>;
type RemoteCompactionModelKey = { provider: string; api: string; id: string };
type Pending = {
  resolve(value: JsonRecord): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): JsonRecord {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function asString(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  return value as string;
}

function assistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    return message.content
      .filter((block): block is JsonRecord => isRecord(block) && block.type === "text")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

function validateRemoteCompaction(
  value: unknown,
  expectedModelKey: RemoteCompactionModelKey,
  expectedCompatibilityClass: string,
): JsonRecord {
  const details = asRecord(value, "compaction details");
  assert.deepEqual(Object.keys(details), ["nativeReplayCheckpoint"]);
  const checkpoint = asRecord(details.nativeReplayCheckpoint, "details.nativeReplayCheckpoint");
  assert.deepEqual(Object.keys(checkpoint).sort(), ["format", "producer", "replacementHistory"]);
  assert.equal(checkpoint.format, checkpointFormat);

  const producer = asRecord(checkpoint.producer, "nativeReplayCheckpoint.producer");
  assert.deepEqual(Object.keys(producer).sort(), ["compactionCompatibilityClass", "modelKey"]);
  assert.equal(producer.compactionCompatibilityClass, expectedCompatibilityClass);
  const modelKey = asRecord(producer.modelKey, "nativeReplayCheckpoint.producer.modelKey");
  assert.deepEqual(Object.keys(modelKey).sort(), ["api", "id", "provider"]);
  assert.deepEqual(modelKey, expectedModelKey);

  assert.ok(Array.isArray(checkpoint.replacementHistory));
  assert.equal(checkpoint.replacementHistory.length, 1);
  const item = asRecord(checkpoint.replacementHistory[0], "replacementHistory[0]");
  assert.equal(item.type, "compaction");
  assert.equal(typeof item.encrypted_content, "string");
  return checkpoint;
}

async function loadJsonl(path: string): Promise<JsonRecord[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
}

class PiRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private counter = 0;
  private closed = false;
  private readonly exited: Promise<void>;
  private resolveExited!: () => void;

  constructor(sessionDir: string, sessionFile?: string) {
    const args = [
      "--mode",
      "rpc",
      "--model",
      selectedModel!,
      "--session-dir",
      sessionDir,
      "--no-extensions",
      "-e",
      extensionPath,
      "--no-tools",
    ];
    if (sessionFile) args.push("--session", sessionFile);

    this.child = spawn("pi", args, {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stderr.write(`unparseable pi stdout: ${line}\n`);
        return;
      }
      if (!isRecord(parsed) || parsed.type !== "response" || typeof parsed.id !== "string") {
        return;
      }
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      pending.resolve(parsed);
    });
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      process.stderr.write(`${line}\n`);
    });
    this.child.on("error", (error) => this.rejectPending(`pi process error: ${error.message}`));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.resolveExited();
      this.rejectPending(`pi exited (code=${String(code)}, signal=${String(signal)})`);
    });
  }

  private rejectPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${message}; pending request ${id}`));
    }
    this.pending.clear();
  }

  async send(command: JsonRecord, timeoutMs = 120_000): Promise<JsonRecord> {
    assert.equal(this.closed, false, "pi process is closed");
    const id = `request-${++this.counter}`;
    const response = await new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi RPC timed out: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
    assert.equal(response.success, true, `pi RPC failed: ${String(response.error)}`);
    return response;
  }

  async waitIdle(timeoutMs = 300_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = asRecord((await this.send({ type: "get_state" }, 30_000)).data, "state");
      if (state.isStreaming !== true && state.isCompacting !== true) return;
      await delay(500);
    }
    throw new Error("timed out waiting for Pi to become idle");
  }

  async prompt(message: string): Promise<void> {
    await this.send({ type: "prompt", message });
    await this.waitIdle();
  }

  async compact(): Promise<JsonRecord> {
    return asRecord((await this.send({ type: "compact" }, 300_000)).data, "compact response");
  }

  async messages(): Promise<unknown[]> {
    const data = asRecord((await this.send({ type: "get_messages" }, 30_000)).data, "messages");
    assert.ok(Array.isArray(data.messages));
    return data.messages;
  }

  async modelKey(): Promise<RemoteCompactionModelKey> {
    const state = asRecord((await this.send({ type: "get_state" }, 30_000)).data, "state");
    const selected = asRecord(state.model, "state.model");
    const provider = asString(selected.provider, "state.model.provider");
    const api = asString(selected.api, "state.model.api");
    const id = asString(selected.id, "state.model.id");
    assert.ok(
      api === "openai-responses" ||
        (provider === "openai-codex" && api === "openai-codex-responses"),
      `selected model is not eligible: ${provider}/${api}/${id}`,
    );
    return { provider, api, id };
  }

  async sessionFile(): Promise<string> {
    const state = asRecord((await this.send({ type: "get_state" }, 30_000)).data, "state");
    return asString(state.sessionFile, "state.sessionFile");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.send({ type: "shutdown" }, 10_000);
    } catch {
      // Best effort; terminate below.
    }
    if (!this.closed) {
      this.child.kill("SIGTERM");
      await Promise.race([
        this.exited,
        delay(10_000).then(() => {
          if (!this.closed) this.child.kill("SIGKILL");
        }),
      ]);
    }
  }
}

test(
  "real endpoint preserves linear, repeated, and reloaded native replay",
  {
    skip: selectedModel
      ? false
      : "PI_OPENAI_SERVER_COMPACTION_TEST_MODEL was not supplied; live acceptance not run",
    timeout: 1_200_000,
  },
  async () => {
    const artifacts = await mkdtemp(join(tmpdir(), "pi-remote-compaction-live-"));
    const sessionDir = join(artifacts, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const firstSecret = `FIRST-${randomBytes(8).toString("hex").toUpperCase()}`;
    const secondSecret = `SECOND-${randomBytes(8).toString("hex").toUpperCase()}`;
    let sessionFile = "";
    let secondDetails: unknown;
    let expectedModelKey: RemoteCompactionModelKey;
    let expectedCompatibilityClass: string;

    try {
      const client = new PiRpcClient(sessionDir);
      try {
        await client.waitIdle();
        expectedModelKey = await client.modelKey();
        const selectedCompatibilityClass = resolveCodexCompactionCompatibilityClass(
          expectedModelKey.id,
        );
        assert.ok(
          selectedCompatibilityClass,
          `live model has no cataloged compatibility class: ${expectedModelKey.id}`,
        );
        expectedCompatibilityClass = selectedCompatibilityClass;
        await client.prompt(
          `Remember this unpredictable first secret for later: ${firstSecret}. Reply only with MEMORIZED-FIRST.`,
        );
        await client.prompt(`${paddingBeyondDefaultRetainedSuffix}\nReply only with READY-FIRST.`);

        const first = await client.compact();
        assert.equal(first.summary, checkpointMarker);
        const firstCheckpoint = validateRemoteCompaction(
          first.details,
          expectedModelKey,
          expectedCompatibilityClass,
        );
        const firstVisible = JSON.stringify({
          ...firstCheckpoint,
          replacementHistory: (firstCheckpoint.replacementHistory as JsonRecord[]).map((item) => ({
            ...item,
            encrypted_content: "<redacted>",
          })),
        });
        assert.doesNotMatch(firstVisible, new RegExp(firstSecret));

        await client.prompt("What was the first secret? Reply with only the exact secret.");
        assert.match(assistantText(await client.messages()), new RegExp(firstSecret));

        await client.prompt(
          `Remember this unpredictable second secret too: ${secondSecret}. Reply only with MEMORIZED-SECOND.`,
        );
        await client.prompt(`${paddingBeyondDefaultRetainedSuffix}\nReply only with READY-SECOND.`);
        const second = await client.compact();
        assert.equal(second.summary, checkpointMarker);
        validateRemoteCompaction(second.details, expectedModelKey, expectedCompatibilityClass);
        secondDetails = second.details;
        sessionFile = await client.sessionFile();

        const sameProcessEntries = await loadJsonl(sessionFile);
        const sameProcessLatest = sameProcessEntries
          .filter((entry) => entry.type === "compaction")
          .at(-1);
        assert.ok(sameProcessLatest);
        assert.equal(sameProcessLatest.summary, checkpointMarker);
        assert.deepEqual(sameProcessLatest.details, secondDetails);
        validateRemoteCompaction(
          sameProcessLatest.details,
          expectedModelKey,
          expectedCompatibilityClass,
        );
        const firstCheckpointEntry = sameProcessEntries
          .filter((entry) => entry.type === "compaction")
          .at(-2);
        assert.ok(firstCheckpointEntry);
        const firstDecision = sameProcessEntries.find(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === compatibilityDecisionType &&
            isRecord(entry.data) &&
            entry.data.checkpointId === firstCheckpointEntry.id,
        );
        assert.ok(firstDecision, "same-process replay must persist compatibility evidence");
      } finally {
        await client.close();
      }

      const resumed = new PiRpcClient(sessionDir, sessionFile);
      try {
        await resumed.waitIdle();
        await resumed.prompt(
          "Reply with both remembered secrets, exactly, separated by one space and no other text.",
        );
        const answer = assistantText(await resumed.messages());
        assert.match(answer, new RegExp(firstSecret));
        assert.match(answer, new RegExp(secondSecret));
      } finally {
        await resumed.close();
      }

      const entries = await loadJsonl(sessionFile);
      const compactions = entries.filter((entry) => entry.type === "compaction");
      assert.ok(compactions.length >= 2);
      const latest = compactions.at(-1)!;
      assert.equal(latest.summary, checkpointMarker);
      assert.deepEqual(latest.details, secondDetails);
      validateRemoteCompaction(latest.details, expectedModelKey, expectedCompatibilityClass);
      const latestDecision = entries.find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === compatibilityDecisionType &&
          isRecord(entry.data) &&
          entry.data.checkpointId === latest.id,
      );
      assert.ok(latestDecision, "fresh-process replay must persist compatibility evidence");
      const decisionData = asRecord(latestDecision.data, "compatibility decision data");
      assert.equal(decisionData.compatible, true);
      const target = asRecord(decisionData.target, "compatibility decision target");
      assert.equal(target.compactionCompatibilityClass, expectedCompatibilityClass);
      assert.deepEqual(target.modelKey, expectedModelKey);

      await rm(artifacts, { recursive: true, force: true });
    } catch (error) {
      process.stderr.write(`Live Remote compaction artifacts retained at: ${artifacts}\n`);
      throw error;
    }
  },
);
