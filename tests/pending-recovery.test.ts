import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { flushAllPending, resolvePendingSessions } from "../src/commands/session";
import { loadConfig } from "../src/config";
import { hasPendingFlag, touchPendingFlag } from "../src/queue";
import { parseAndUpsertSession } from "../src/retention";

function config() {
  const result = loadConfig(mkdtempSync(join(tmpdir(), "epimetheus-recovery-config-"))).config;
  result.apiUrl = "https://service.invalid";
  result.apiKey = "fake-key";
  result.bankId = "fake-bank";
  result.observationScopes = "shared";
  return result;
}

function session(path: string, id: string, cwd: string, content: string) {
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content },
      }),
    ].join("\n")
  );
}

async function withAgentDir(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "epimetheus-pending-recovery-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const context = {
  signal: new AbortController().signal,
  ui: { notify() {} },
};

test("pending recovery uses a validated marker path without scanning session history", async () => {
  await withAgentDir(async (root) => {
    const id = "marker-path-session";
    const path = join(root, "custom-session-location.jsonl");
    session(path, id, root, "recover from marker path");
    writeFileSync(join(root, "sessions"), "history discovery must not run");
    assert.equal(touchPendingFlag(id, "message_end", path).success, true);

    const retained: string[] = [];
    await flushAllPending(
      config(),
      {
        async retain(options: { documentId: string }) {
          retained.push(options.documentId);
          return { success: true };
        },
      } as never,
      context as never,
      { autoFlush: true }
    );

    assert.deepEqual(retained, [id]);
    assert.equal(hasPendingFlag(id), false);
  });
});

test("stale path hints fall back to targeted standard-filename discovery", async () => {
  await withAgentDir(async (root) => {
    const id = "stale-marker-session";
    const sessionDir = join(root, "sessions", "--project--");
    const path = join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    mkdirSync(sessionDir, { recursive: true });
    session(path, id, root, "fallback recovery");
    assert.equal(touchPendingFlag(id, "message_end", join(root, "moved.jsonl")).success, true);

    const retained: string[] = [];
    await flushAllPending(
      config(),
      {
        async retain(options: { documentId: string }) {
          retained.push(options.documentId);
          return { success: true };
        },
      } as never,
      context as never,
      { autoFlush: true }
    );

    assert.deepEqual(retained, [id]);
    assert.equal(hasPendingFlag(id), false);
  });
});

test("a valid custom path wins when another marker contains a stale hint", async () => {
  await withAgentDir(async (root) => {
    const id = "multiple-hint-session";
    const validPath = join(root, "custom-valid-session.jsonl");
    session(validPath, id, root, "use the valid marker path");
    assert.equal(touchPendingFlag(id, "old-location", join(root, "stale.jsonl")).success, true);
    assert.equal(touchPendingFlag(id, "new-location", validPath).success, true);

    const resolved = await resolvePendingSessions([id]);
    assert.equal(resolved.get(id)?.path, validPath);
  });
});

test("legacy discovery caps do not discard validated standard sessions", async () => {
  await withAgentDir(async (root) => {
    const id = "standard-session";
    const sessionDir = join(root, "sessions", "--project--");
    mkdirSync(sessionDir, { recursive: true });
    const standardPath = join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    session(standardPath, id, root, "standard session");
    for (let index = 0; index < 2049; index += 1) {
      writeFileSync(join(sessionDir, `legacy-${index}.jsonl`), "");
    }

    const resolved = await resolvePendingSessions([id]);
    assert.equal(resolved.get(id)?.path, standardPath);
  });
});

test("missing hinted sessions remain pending for later recovery", async () => {
  await withAgentDir(async (root) => {
    const id = "absent-hinted-session";
    assert.equal(
      touchPendingFlag(id, "message_end", join(root, "temporarily-unavailable.jsonl")).success,
      true
    );
    const notifications: string[] = [];

    await flushAllPending(
      config(),
      { retain: () => Promise.reject(new Error("not reached")) } as never,
      {
        signal: new AbortController().signal,
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as never,
      { autoFlush: true }
    );

    assert.equal(hasPendingFlag(id), true);
    assert.equal(
      notifications.filter((message) => message.includes("session file not found")).length,
      1
    );
  });
});

test("cancellation after submission reports an unknown outcome and restores pending work", async () => {
  await withAgentDir(async (root) => {
    const id = "unknown-outcome-session";
    const path = join(root, "session.jsonl");
    session(path, id, root, "leave this session recoverable");
    assert.equal(touchPendingFlag(id, "message_end", path).success, true);

    const controller = new AbortController();
    const notifications: Array<{ message: string; level: string }> = [];
    await parseAndUpsertSession(
      path,
      id,
      config(),
      {
        retain() {
          controller.abort();
          return new Promise<never>(() => {});
        },
      } as never,
      {
        signal: controller.signal,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      } as never,
      controller.signal,
      { requirePending: true }
    );

    assert.equal(hasPendingFlag(id), true);
    assert.deepEqual(notifications, [
      {
        message:
          "Retention submission did not finish before cancellation; pending work was preserved for retry.",
        level: "warning",
      },
    ]);
  });
});
