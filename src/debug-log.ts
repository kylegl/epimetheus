/**
 * File-backed debug logging for epimetheus.
 *
 * Pi's interactive TUI owns the terminal, so `console.log`/`console.warn`/
 * `console.error` output from extensions is overwritten/swallowed and not
 * captured to any file. This makes diagnostic output (e.g. session-start
 * phase failures and parse timings) invisible to the user.
 *
 * This module mirrors every epimetheus console message to a persistent file
 * at `<agentdir>/epimetheus/debug.log` so it can be `tail -f`'d. Files rotate
 * at 5 MiB with two backups (`debug.log.1` and `.2`), bounding normal retained
 * output to roughly 15 MiB. Individual persisted entries are capped at 64 KiB.
 * The helpers also call the matching `console.*` method so existing behavior
 * (TUI error surfacing, print-mode stdout) is unchanged.
 *
 * Logging is best-effort: a file write failure never throws. Writes use
 * synchronous filesystem operations and may briefly block the caller. The
 * agent dir is resolved lazily on each call so env changes (e.g.
 * `PI_CODING_AGENT_DIR` in tests) are respected.
 *
 * Callers keep their existing `config.debug` gating for verbose messages; the
 * helpers themselves are unconditional so warnings/errors always persist.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { LOG_PREFIX } from "./constants";

export const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DEBUG_LOG_BACKUP_COUNT = 2;
export const DEBUG_LOG_MAX_ENTRY_BYTES = 64 * 1024;

/**
 * Bytes at the front of a retained window we're willing to drop to avoid
 * keeping a partial first line. Newlines are line boundaries, not whole-entry
 * boundaries (a message or stack may embed newlines), so we only skip an
 * early line and never discard most of the window chasing a far newline.
 */
const DEBUG_LOG_MAX_PARTIAL_LINE_SKIP = 64 * 1024;

/** Resolve the debug log path under the current agent dir. */
function getDebugLogPath(): string {
  return join(getAgentDir(), "epimetheus", "debug.log");
}

/** Keep a UTF-8 string within a byte budget without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  const chars: string[] = [];
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    chars.push(char);
    bytes += charBytes;
  }
  return chars.join("");
}

/** Bound one entry so a single large error cannot bypass file rotation. */
function boundEntry(entry: string): string {
  if (Buffer.byteLength(entry, "utf8") <= DEBUG_LOG_MAX_ENTRY_BYTES) return entry;
  const suffix = "\n[log entry truncated]\n";
  const budget = DEBUG_LOG_MAX_ENTRY_BYTES - Buffer.byteLength(suffix, "utf8");
  return truncateUtf8(entry, budget) + suffix;
}

/**
 * Keep the newest bytes of an over-limit segment, bounded to maxBytes, so a
 * retained tail never starts mid-UTF-8. Newlines are line boundaries, not
 * complete-entry boundaries, so we only skip a partial first line when its
 * newline sits near the front of the window; otherwise we fall back to a raw
 * byte tail (advancing past at most a few leading continuation bytes). Used to
 * bound oversized pre-existing segments (e.g. a debug.log written before the
 * rotation policy) so rotation never moves an oversized file to a backup.
 * Shrinks in place; best-effort, never throws.
 */
function trimToNewestBytes(path: string, maxBytes: number): void {
  const size = statSync(path).size;
  if (size <= maxBytes) return;
  const fd = openSync(path, "r");
  const tail = Buffer.alloc(maxBytes);
  let read = 0;
  try {
    read = readSync(fd, tail, 0, maxBytes, size - maxBytes);
  } finally {
    closeSync(fd);
  }
  const window = tail.subarray(0, read);

  let start = 0;
  const newline = window.indexOf(0x0a);
  if (newline !== -1 && newline <= DEBUG_LOG_MAX_PARTIAL_LINE_SKIP) {
    // Skip a short partial first line (its newline is close to the front of
    // the window) so the tail does not begin mid-line.
    start = newline + 1;
  } else {
    // No useful line boundary near the front (e.g. a single huge line): keep a
    // raw byte tail, advancing past at most the leading continuation bytes so
    // the retained file starts at a valid UTF-8 code-point boundary.
    while (start < window.length && isContinuationByte(window[start])) {
      start++;
    }
  }

  writeFileSync(path, window.subarray(start));
}

/** True when a UTF-8 byte is a continuation byte (0x80..0xBF). */
function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/**
 * Rotate debug.log → .1 and older backups up to the configured count, first
 * trimming each segment to at most the per-file limit so an oversized legacy
 * log or backup never moves (or remains) over budget.
 */
function rotateLog(path: string): void {
  for (let index = DEBUG_LOG_BACKUP_COUNT; index >= 1; index--) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    if (!existsSync(source)) continue;
    const destination = `${path}.${index}`;
    trimToNewestBytes(source, DEBUG_LOG_MAX_BYTES);
    rmSync(destination, { force: true });
    renameSync(source, destination);
  }
}

/** Rotate before an append that would exceed the active-file limit. */
function rotateIfNeeded(path: string, incomingBytes: number): void {
  const currentBytes = existsSync(path) ? statSync(path).size : 0;
  if (currentBytes + incomingBytes > DEBUG_LOG_MAX_BYTES) rotateLog(path);
}

/** Write a timestamped, leveled entry to the debug log file. Best-effort. */
function writeLog(level: "log" | "warn" | "error", message: string): void {
  try {
    const path = getDebugLogPath();
    mkdirSync(dirname(path), { recursive: true });
    const timestamp = new Date().toISOString();
    const entry = boundEntry(`[${timestamp}] [${level}] ${message}\n`);
    rotateIfNeeded(path, Buffer.byteLength(entry, "utf8"));
    appendFileSync(path, entry, "utf8");
  } catch {
    // Never throw from logging.
  }
}

/** Stringify variadic console args into a single line for the file. */
function stringify(args: unknown[]): string {
  return args
    .map((a) =>
      typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : String(a)
    )
    .join(" ");
}

/**
 * Log an informational message to the debug log file AND `console.log`.
 * Callers should gate verbose output behind `config.debug`; one-time startup
 * messages (migration, disabled-mode) may call unconditionally.
 */
export function debugLog(...args: unknown[]): void {
  writeLog("log", stringify(args));
  console.log(...args);
}

/**
 * Log a warning to the debug log file AND `console.warn`. Warnings are always
 * persisted (not gated) so transient issues are diagnosable after the fact.
 */
export function debugWarn(...args: unknown[]): void {
  writeLog("warn", stringify(args));
  console.warn(...args);
}

/**
 * Log an error to the debug log file AND `console.error`. Errors are always
 * persisted (not gated).
 */
export function debugError(...args: unknown[]): void {
  writeLog("error", stringify(args));
  console.error(...args);
}

/** Export the resolved path for diagnostics and tests. */
export { getDebugLogPath, LOG_PREFIX };
