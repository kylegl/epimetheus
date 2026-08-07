import { beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEBUG_LOG_BACKUP_COUNT,
  DEBUG_LOG_MAX_BYTES,
  DEBUG_LOG_MAX_ENTRY_BYTES,
  debugError,
  debugLog,
  debugWarn,
  getDebugLogPath,
} from "../src/debug-log";
import { setupTempAgentDir } from "./fixtures";

const agentDir = setupTempAgentDir("debug-log");

beforeEach(() => {
  for (let index = 0; index <= DEBUG_LOG_BACKUP_COUNT + 1; index++) {
    const suffix = index === 0 ? "" : `.${index}`;
    rmSync(`${getDebugLogPath()}${suffix}`, { force: true });
  }
});

describe("file-backed debug logging", () => {
  it("writes timestamped, leveled informational output under the agent directory", () => {
    const originalLog = console.log;
    console.log = mock(() => {});
    try {
      debugLog("hello", "world");
    } finally {
      console.log = originalLog;
    }

    expect(getDebugLogPath()).toBe(join(agentDir, "epimetheus", "debug.log"));
    const content = readFileSync(getDebugLogPath(), "utf8");
    expect(content).toMatch(/^\[[^\]]+\] \[log\] hello world\n$/);
  });

  it("persists warnings and errors without debug-mode gating", () => {
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = mock(() => {});
    console.error = mock(() => {});
    try {
      debugWarn("warning details");
      debugError("error details");
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }

    const content = readFileSync(getDebugLogPath(), "utf8");
    expect(content).toContain("[warn] warning details\n");
    expect(content).toContain("[error] error details\n");
  });

  it("caps a single persisted entry", () => {
    const originalError = console.error;
    console.error = mock(() => {});
    try {
      debugError("x".repeat(DEBUG_LOG_MAX_ENTRY_BYTES * 2));
    } finally {
      console.error = originalError;
    }

    const path = getDebugLogPath();
    expect(statSync(path).size).toBeLessThanOrEqual(DEBUG_LOG_MAX_ENTRY_BYTES);
    expect(readFileSync(path, "utf8")).toContain("[log entry truncated]");
  });

  it("rotates at 5 MiB and retains only two bounded backups", () => {
    const path = getDebugLogPath();
    mkdirSync(dirname(path), { recursive: true });
    const originalWarn = console.warn;
    console.warn = mock(() => {});
    try {
      for (let index = 1; index <= DEBUG_LOG_BACKUP_COUNT + 1; index++) {
        writeFileSync(path, Buffer.alloc(DEBUG_LOG_MAX_BYTES, index));
        debugWarn(`rotation ${index}`);
      }
    } finally {
      console.warn = originalWarn;
    }

    const retainedPaths = [path, `${path}.1`, `${path}.2`];
    for (const retainedPath of retainedPaths) {
      expect(existsSync(retainedPath)).toBe(true);
      expect(statSync(retainedPath).size).toBeLessThanOrEqual(DEBUG_LOG_MAX_BYTES);
    }
    expect(existsSync(`${path}.3`)).toBe(false);
    const retainedBytes = retainedPaths.reduce(
      (total, retainedPath) => total + statSync(retainedPath).size,
      0
    );
    expect(retainedBytes).toBeLessThanOrEqual(DEBUG_LOG_MAX_BYTES * (DEBUG_LOG_BACKUP_COUNT + 1));
  });

  it("self-heals an oversized legacy active log on the next write, retaining newest content", () => {
    const path = getDebugLogPath();
    mkdirSync(dirname(path), { recursive: true });

    // Oversize every segment (active + both backups) with distinguishable lines.
    const makeOversized = (char: string) => {
      const line = `${char.repeat(1024)}\n`;
      return line.repeat(Math.ceil((DEBUG_LOG_MAX_BYTES * 1.2) / Buffer.byteLength(line)));
    };
    const originalActive = makeOversized("A");
    const originalBackup1 = makeOversized("B");
    const originalBackup2 = makeOversized("C");
    writeFileSync(path, originalActive);
    writeFileSync(`${path}.1`, originalBackup1);
    writeFileSync(`${path}.2`, originalBackup2);
    expect(statSync(path).size).toBeGreaterThan(DEBUG_LOG_MAX_BYTES);
    expect(statSync(`${path}.1`).size).toBeGreaterThan(DEBUG_LOG_MAX_BYTES);
    expect(statSync(`${path}.2`).size).toBeGreaterThan(DEBUG_LOG_MAX_BYTES);

    const originalWarn = console.warn;
    console.warn = mock(() => {});
    try {
      debugWarn("self-heal write");
    } finally {
      console.warn = originalWarn;
    }

    // Every retained segment is bounded and no extra backup is created.
    for (const retained of [path, `${path}.1`, `${path}.2`]) {
      expect(existsSync(retained)).toBe(true);
      expect(statSync(retained).size).toBeLessThanOrEqual(DEBUG_LOG_MAX_BYTES);
    }
    expect(existsSync(`${path}.3`)).toBe(false);

    // The freshest write becomes the active file, and each segment retains the
    // newest content of the oversized file it was rotated from (as a suffix).
    expect(readFileSync(path, "utf8")).toContain("[warn] self-heal write\n");
    expect(originalActive.endsWith(readFileSync(`${path}.1`, "utf8"))).toBe(true);
    expect(originalBackup1.endsWith(readFileSync(`${path}.2`, "utf8"))).toBe(true);
  });

  it("bounded-trims an oversized single-line multibyte log, preserving newest bytes", () => {
    const path = getDebugLogPath();
    mkdirSync(dirname(path), { recursive: true });

    // A single huge multibyte line (no newline until the very end) whose tail
    // carries a distinct sentinel, so we can prove the newest bytes survive.
    const sentinel = "NEWEST-CONTENT-SENTINEL-☃";
    const body = "☃".repeat(Math.ceil((DEBUG_LOG_MAX_BYTES + DEBUG_LOG_MAX_ENTRY_BYTES) / 3));
    const oversized = `${body}${sentinel}\n`;
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(DEBUG_LOG_MAX_BYTES);
    writeFileSync(path, oversized);

    const originalWarn = console.warn;
    console.warn = mock(() => {});
    try {
      debugWarn("trigger rotation");
    } finally {
      console.warn = originalWarn;
    }

    const backup = `${path}.1`;
    expect(existsSync(backup)).toBe(true);
    const backupBytes = statSync(backup).size;
    expect(backupBytes).toBeGreaterThan(0);
    expect(backupBytes).toBeLessThanOrEqual(DEBUG_LOG_MAX_BYTES);

    const content = readFileSync(backup, "utf8");
    expect(content).toContain(sentinel);
    expect(content.endsWith("\n")).toBe(true);
    // Starts at a valid UTF-8 boundary, so no split code point remained.
    expect(content).not.toContain("\uFFFD");

    // The fresh write landed in the new active file, confirming real rotation.
    expect(readFileSync(path, "utf8")).toContain("[warn] trigger rotation\n");
  });

  it("does not throw and still calls the console method when persistent logging fails", () => {
    // Block the epimetheus directory with a regular file so file writes fail.
    const blockPath = join(agentDir, "epimetheus");
    rmSync(blockPath, { recursive: true, force: true });
    writeFileSync(blockPath, "not a directory");

    const originalWarn = console.warn;
    const originalError = console.error;
    const warn = mock(() => {});
    const error = mock(() => {});
    console.warn = warn;
    console.error = error;
    try {
      expect(() => debugWarn("persist fails warning")).not.toThrow();
      expect(() => debugError("persist fails error")).not.toThrow();
      expect(warn).toHaveBeenCalledWith("persist fails warning");
      expect(error).toHaveBeenCalledWith("persist fails error");
      expect(existsSync(getDebugLogPath())).toBe(false);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      rmSync(blockPath, { recursive: true, force: true });
    }
  });

  it("truncates a multibyte entry without splitting a UTF-8 code point", () => {
    const originalError = console.error;
    console.error = mock(() => {});
    try {
      debugError("☃".repeat(DEBUG_LOG_MAX_ENTRY_BYTES));
    } finally {
      console.error = originalError;
    }

    const path = getDebugLogPath();
    expect(statSync(path).size).toBeLessThanOrEqual(DEBUG_LOG_MAX_ENTRY_BYTES);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("[log entry truncated]");
    // A replacement char means a code point was split across the byte budget.
    expect(content).not.toContain("\uFFFD");
  });
});
