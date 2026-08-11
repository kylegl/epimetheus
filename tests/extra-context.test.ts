import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateConfig } from "../src/config";
import { generateExtraContext } from "../src/extra-context";
import { getHindsightMeta } from "../src/meta";
import { hasPendingFlag, touchPendingFlag } from "../src/queue";
import { parseAndUpsertSession } from "../src/retention";

function config(root: string) {
  const value: any = loadConfig(root).config;
  value.apiUrl = "https://service.invalid";
  value.apiKey = "fake-key";
  value.bankId = "fake-bank";
  value.requireExtraContextBeforeFlush = true;
  value.extraContextGeneration = {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "medium",
  };
  return value;
}

function session(path: string, id: string, cwd: string, extraContext?: string) {
  const entries = [
    { type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "Research how a third-party memory system behaves." },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The documented system behavior differs from the user configuration.",
          },
        ],
      },
    },
  ];
  if (extraContext !== undefined) {
    entries.push({
      type: "custom",
      id: "m1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "hindsight-meta",
      data: { extraContext },
    } as never);
  }
  writeFileSync(path, `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function context(path: string, completion?: unknown) {
  return {
    sessionManager: SessionManager.open(path),
    modelRegistry: {
      find(provider: string, model: string) {
        assert.equal(provider, "openai-codex");
        assert.equal(model, "gpt-5.6-luna");
        return { provider, id: model, contextWindow: 272_000 };
      },
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "fake-model-key", headers: { "x-test": "yes" }, env: {} };
      },
    },
    ui: { notify() {} },
    completion,
  };
}

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("configured auxiliary model and thinking level generate extra context without changing the active model", async () => {
  const ctx = context("/tmp/unused");
  const result = await generateExtraContext(
    [{ role: "user", content: "third-party research" }],
    { model: "openai-codex/gpt-5.6-luna", thinkingLevel: "medium" },
    ctx as never,
    undefined,
    async (model, request, options) => {
      assert.equal(model.id, "gpt-5.6-luna");
      assert.equal(options?.reasoningEffort, "medium");
      assert.equal(options?.apiKey, "fake-model-key");
      assert.match(JSON.stringify(request.messages[0]?.content), /third-party research/);
      return {
        role: "assistant",
        content: [
          { type: "text", text: "Treat system details as researched third-party behavior." },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
      };
    }
  );
  assert.equal(result.text, "Treat system details as researched third-party behavior.");
});

test("automatic generation persists once and the first upsert uses it", async () => {
  const root = mkdtempSync(join(tmpdir(), "epimetheus-generated-context-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const id = "generated-context-session";
    const path = join(root, "session.jsonl");
    session(path, id, root);
    let generated = 0;
    let retainedContext = "";
    const activeContext = context(path);
    const appendActiveEntry = (customType: string, data?: unknown) =>
      activeContext.sessionManager.appendCustomEntry(customType, data);
    await parseAndUpsertSession(
      path,
      id,
      config(root),
      {
        async retain(options: { context: string }) {
          retainedContext = options.context;
          return { success: true };
        },
      } as never,
      activeContext as never,
      undefined,
      {
        generateExtraContext: async () => {
          generated += 1;
          return { text: "Treat the discussed product behavior as third-party research.", usage };
        },
        appendActiveEntry,
      } as never
    );
    assert.equal(generated, 1);
    assert.match(retainedContext, /third-party research/);
    assert.equal(hasPendingFlag(id), false);
    const parsed = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      getHindsightMeta(parsed)?.extraContext,
      "Treat the discussed product behavior as third-party research."
    );

    await parseAndUpsertSession(
      path,
      id,
      config(root),
      {
        async retain() {
          return { success: true };
        },
      } as never,
      activeContext as never,
      undefined,
      {
        generateExtraContext: async () => {
          generated += 1;
          return { text: "must not replace persisted context", usage };
        },
        appendActiveEntry,
      } as never
    );
    assert.equal(generated, 1);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending recovery writes generated context to the target non-active session", async () => {
  const root = mkdtempSync(join(tmpdir(), "epimetheus-non-active-context-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const targetId = "target-context-session";
    const targetPath = join(root, "target.jsonl");
    const activePath = join(root, "active.jsonl");
    session(targetPath, targetId, root);
    session(activePath, "active-session", root, "");
    let retainedContext = "";
    await parseAndUpsertSession(
      targetPath,
      targetId,
      config(root),
      {
        async retain(options: { context: string }) {
          retainedContext = options.context;
          return { success: true };
        },
      } as never,
      context(activePath) as never,
      undefined,
      {
        generateExtraContext: async () => ({
          text: "Generated for the pending target session.",
          usage,
        }),
      } as never
    );
    assert.match(retainedContext, /pending target session/);
    const targetEntries = readFileSync(targetPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const activeEntries = readFileSync(activePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      getHindsightMeta(targetEntries)?.extraContext,
      "Generated for the pending target session."
    );
    assert.equal(getHindsightMeta(activeEntries)?.extraContext, "");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit empty context skips generation and satisfies the guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "epimetheus-empty-context-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const id = "empty-context-session";
    const path = join(root, "session.jsonl");
    session(path, id, root, "");
    let generated = false;
    let retained = false;
    await parseAndUpsertSession(
      path,
      id,
      config(root),
      {
        async retain() {
          retained = true;
          return { success: true };
        },
      } as never,
      context(path) as never,
      undefined,
      {
        generateExtraContext: async () => {
          generated = true;
          return { text: "unexpected", usage };
        },
      } as never
    );
    assert.equal(generated, false);
    assert.equal(retained, true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation failure preserves pending work and prevents retention", async () => {
  const root = mkdtempSync(join(tmpdir(), "epimetheus-generation-failure-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const id = "failed-generation-session";
    const path = join(root, "session.jsonl");
    session(path, id, root);
    assert.equal(touchPendingFlag(id, "message_end", path).success, true);
    let retained = false;
    await parseAndUpsertSession(
      path,
      id,
      config(root),
      {
        async retain() {
          retained = true;
          return { success: true };
        },
      } as never,
      context(path) as never,
      undefined,
      {
        requirePending: true,
        generateExtraContext: async () => {
          throw new Error("auxiliary model unavailable");
        },
      } as never
    );
    assert.equal(retained, false);
    assert.equal(hasPendingFlag(id), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed extra-context generation config fails closed", () => {
  const value = config(mkdtempSync(join(tmpdir(), "epimetheus-generation-config-")));
  value.extraContextGeneration = { model: "luna", thinkingLevel: "medium" };
  const validation = validateConfig(value);
  assert.equal(validation.valid, false);
  assert.equal(value.extraContextGeneration, null);
});
