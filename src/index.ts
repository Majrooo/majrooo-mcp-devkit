/*
 * majrooo-mcp-devkit
 * Copyright (C) 2026 majrooo <https://github.com/majrooo>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// src/index.ts — MCP server with safe command execution
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { appendFile, writeFile, readFile, stat, rename } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import os from "os";
import {
  ALLOWED_ROOTS,
  BLOCK_CROSS_ROOT_READS,
  findEscapeReason,
  isDangerous,
  resolveCwdRequested,
  findOutOfRootWriteTargets,
  findSuspiciousCrossRootReads,
  findAllowedProjects,
  findAliasByName,
  findAliasByPath,
  resolveFilePath,
  PROJECT_ALIASES,
  extractRedirectTargets,
  extractDestructiveTargets,
  type Registration,
} from "./safety.js";
import { stripAnsi, withUtf8Encoding } from "./output.js";
import { buildRedirectNote } from "./redirect.js";
import { composeFailureMessage, extractExecFailure, formatCommandError, textResult, jsonResult } from "./format.js";
import { universalFindReferences, extractCodeBlock, type FileReferences } from "./symbols.js";
import { splitFileByDeclarations } from "./split.js";
import { batchApplyEdits } from "./batch.js";
import { generateModuleSkeleton } from "./skeleton.js";
import { verifyRefactorSafety } from "./verify.js";
import { reportToolFeedback, readFeedbackEntries, closeFeedback } from "./feedback.js";
import { registerToolInfo, listToolInfos, getToolInfo } from "./tool-registry.js";

const execAsync = promisify(exec);

function getPackageVersion(): string {
  try {
    const raw = readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf-8");
    return JSON.parse(raw).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getExecOptions(cwd: string, timeoutMs: number) {
  return {
    maxBuffer: 1024 * 1024 * 50, // 50 MB
    timeout: timeoutMs,
    cwd,
    // Discourage ANSI color output (vitest/jest/chalk) before we even
    // receive it. stripAnsi stays as a fallback for tools that ignore
    // these environment variables.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  };
}

const server = new McpServer({
  name: "majrooo-mcp-devkit",
  version: getPackageVersion(),
});

// ── Helpers ────────────────────────────────────────────────

function getTempLogPath(): string {
  const timestamp = Date.now();
  return path.join(os.tmpdir(), `cmd-output-${timestamp}.log`);
}

function parseLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function getAuditLogPath(): string {
  return path.join(os.tmpdir(), "mcp-command-audit.log");
}

/** Rotate the audit log when it exceeds this size (5 MB). */
const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024;

async function writeAuditLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const auditPath = getAuditLogPath();
    // Best-effort rotation: if the log already exceeds the cap, move it aside
    // (overwriting the previous `.old`) and start a fresh file.
    try {
      const { size } = await stat(auditPath);
      if (size > AUDIT_LOG_MAX_BYTES) {
        await rename(auditPath, `${auditPath}.old`);
      }
    } catch {
      // File does not exist yet (or stat/rename raced) — that's fine.
    }
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(auditPath, line, "utf-8");
  } catch (err) {
    console.error("[audit-log] Failed to write audit entry:", err);
  }
}

type ExecResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

type SafetyVerdict =
  | { kind: "ok" }
  | { kind: "directory_escape"; reason: string }
  | { kind: "dangerous"; match: string }
  | { kind: "outside_root_write"; targets: { target: string; reason: string }[] }
  | { kind: "cross_root_read"; targets: string[] };

/**
 * Run all safety checks for a command against the active project root.
 * `cwd` is already validated by the caller (resolveToolCwd).
 * Returns a structured verdict so the audit log does not have to guess
 * the reason from a free-text string.
 */
function safetyCheck(command: string, cwd: string, registration: Registration): SafetyVerdict {
  const escape = findEscapeReason(command);
  if (escape) {
    return { kind: "directory_escape", reason: escape };
  }

  const dangerous = isDangerous(command);
  if (dangerous) {
    return { kind: "dangerous", match: dangerous };
  }

  const writes = findOutOfRootWriteTargets(command, cwd, registration);
  if (writes.length > 0) {
    return { kind: "outside_root_write", targets: writes };
  }

  if (BLOCK_CROSS_ROOT_READS) {
    const reads = findSuspiciousCrossRootReads(command, cwd, registration);
    if (reads.length > 0) {
      return { kind: "cross_root_read", targets: reads };
    }
  }

  return { kind: "ok" };
}

/**
 * Destructive commands (rmdir, del, erase, Remove-Item) whose target does not
 * exist in the active `cwd` almost always mean a missing/incorrect `cwd`
 * (e.g. `rmdir /s /q awesome-tauri` executed in the primary project). Return
 * the missing targets so we can fail with a "set the cwd parameter" message
 * instead of a raw `The system cannot find the file specified`.
 */
async function findMissingDestructiveTargets(command: string, cwd: string): Promise<string[]> {
  const missing: string[] = [];
  for (const raw of extractDestructiveTargets(command)) {
    const cleaned = raw.replace(/^["']|["']$/g, "");
    // Skip shell variables ($env:..., %VAR%) and wildcards.
    if (cleaned.includes("$") || cleaned.includes("%")) continue;
    if (cleaned.includes("*") || cleaned.includes("?")) continue;
    const resolved = path.resolve(cwd, cleaned);
    try {
      await stat(resolved);
    } catch {
      missing.push(`${cleaned} (${resolved})`);
    }
  }
  return missing;
}

function buildMissingTargetMessage(missingTargets: string[], cwd: string): string {
  const rootList = ALLOWED_ROOTS.map((r) => `  - ${r}`).join("\n");
  return [
    `Príkaz odmietnutý — cieľ destruktívneho príkazu neexistuje v aktívnom projektovom koreni.`,
    `Aktívny koreň (cwd): ${cwd}`,
    ``,
    `Chýbajúce ciele:`,
    ...missingTargets.map((t) => `  - ${t}`),
    ``,
    `Pravdepodobne chýba/nesedí parameter "cwd" — cieľ sa možno nachádza v inom projekte.`,
    `Prepni projekt cez parameter "cwd" (prípadne friendly name) alebo si pozri`,
    `povolené korene cez tool "list_allowed_roots":`,
    rootList,
  ].join("\n");
}

function verdictToMessage(verdict: Exclude<SafetyVerdict, { kind: "ok" }>, activeRoot: string): string {
  const rootList = ALLOWED_ROOTS.map((r) => `  - ${r}`).join("\n");

  switch (verdict.kind) {
    case "directory_escape":
      return [
        `Príkaz odmietnutý — pokus o opustenie aktívneho projektového koreňa.`,
        `Zistený vzor: ${verdict.reason}`,
        ``,
        `Aktívny koreň (cwd): ${activeRoot}`,
        `Povolené korene (MCP_PROJECT_ROOT / MCP_EXTRA_ROOTS):`,
        rootList,
        ``,
        `Prepnúť projekt = použiť parameter "cwd". Príkazy typu "cd ..", "cd C:\\...", "cd /d D:\\..." sú zakázané.`,
      ].join("\n");

    case "dangerous":
      return [
        `⚠️  Príkaz bol označený ako potenciálne nebezpečný!`,
        `   Zhoda so vzorom: ${verdict.match}`,
        ``,
        `Ak si si istý, použij tool "run_destructive_command" s parametrom "confirm: true".`,
      ].join("\n");

    case "outside_root_write":
      return [
        `Príkaz odmietnutý — zápis mimo aktívneho projektového koreňa.`,
        `Aktívny koreň (cwd): ${activeRoot}`,
        ``,
        `Zachytené ciele zápisu:`,
        ...verdict.targets.map((t) => `  - ${t.target} (${t.reason})`),
        ``,
        `Zápis je povolený len DO aktívneho projektu. Ak naozaj potrebuješ zapísať do iného projektu,`,
        `vyber ho cez parameter "cwd" (musí byť v MCP_PROJECT_ROOT / MCP_EXTRA_ROOTS).`,
        ``,
        `Poznámka: ide o best-effort kontrolu (presmerovania ">", copy/move/mkdir/tee/curl -o/...),`,
        `nie o úplnú izoláciu súborového systému.`,
      ].join("\n");

    case "cross_root_read":
      return [
        `Príkaz odmietnutý — čítanie mimo aktívneho projektového koreňa (MCP_BLOCK_CROSS_ROOT_READS=1).`,
        `Aktívny koreň (cwd): ${activeRoot}`,
        ``,
        `Zachytené ciele čítania:`,
        ...verdict.targets.map((t) => `  - ${t}`),
        ``,
        `Poznámka: ide o best-effort heuristiku, nie o úplnú izoláciu súborového systému.`,
      ].join("\n");
  }
}

async function executeCommand(
  command: string,
  cwd: string,
  registration: Registration,
  maxLines: number,
  confirm: boolean,
  timeoutMs: number,
): Promise<ExecResult> {
  // 1. Safety checks
  const verdict = safetyCheck(command, cwd, registration);

  if (verdict.kind !== "ok") {
    if (!confirm) {
      await writeAuditLog({
        command,
        cwd,
        status: "rejected",
        reason: verdict.kind,
        detail: verdict.kind === "outside_root_write"
          ? verdict.targets.map((t) => t.target)
          : verdict.kind === "cross_root_read"
            ? verdict.targets
            : undefined,
      });
      return {
        content: [{ type: "text" as const, text: verdictToMessage(verdict, cwd) }],
        isError: true,
      };
    }
    // confirm === true — log it prominently
    console.error(`[DESTRUCTIVE] cwd=${cwd} ${command} (confirmed)`);
  }

  // 2. Execute
  try {
    const missingTargets = await findMissingDestructiveTargets(command, cwd);
    if (missingTargets.length > 0) {
      await writeAuditLog({ command, cwd, status: "rejected", reason: "missing_destructive_target", confirm });
      return {
        content: [{ type: "text" as const, text: buildMissingTargetMessage(missingTargets, cwd) }],
        isError: true,
      };
    }

    const safeMax = Math.max(1, maxLines);
    // On Windows, force UTF-8 output — the legacy OEM codepage (e.g. CP852)
    // would otherwise decode into U+FFFD `` replacement characters.
    const { stdout, stderr } = await execAsync(withUtf8Encoding(command), getExecOptions(cwd, timeoutMs));

    const rawOutput = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
    const fullOutput = stripAnsi(rawOutput);
    const lines = parseLines(fullOutput);
    const totalLines = lines.length;
    let content: string;

    if (totalLines <= safeMax) {
      content = fullOutput;
    } else {
      const logPath = getTempLogPath();
      await writeFile(logPath, fullOutput, "utf-8");

      const half = Math.floor(safeMax / 2);
      const firstPart = lines.slice(0, half).join("\n");
      const lastPart = lines.slice(totalLines - half).join("\n");
      content =
        `[Výstup orezaný — celkovo ${totalLines} riadkov]\n` +
        `[Plný výstup uložený v: ${logPath}]\n\n` +
        `${firstPart}\n...\n${lastPart}`;
    }

    // When the caller redirected the output into a file (`npm test > test.log 2>&1`),
    // stdout/stderr are empty — report where the output went and show the file.
    const redirectTargets = extractRedirectTargets(command);
    const redirectNote = await buildRedirectNote(redirectTargets, cwd, maxLines);
    if (redirectNote) {
      content = content.trim()
        ? `${content}\n\n${redirectNote}`
        : redirectNote;
    }

    await writeAuditLog({ command, cwd, status: "ok", confirm });
    return { content: [{ type: "text" as const, text: content }] };
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const details = extractExecFailure(error);
    const redirectTargets = extractRedirectTargets(command);
    const redirectNote = await buildRedirectNote(redirectTargets, cwd, maxLines);

    const message = composeFailureMessage({
      rawError: rawMessage,
      command,
      cwd,
      details,
      maxLines,
      redirectNote,
    });

    await writeAuditLog({ command, cwd, status: "error", error: rawMessage, confirm });
    return {
      content: [{ type: "text" as const, text: `Chyba: ${message}` }],
      isError: true,
    };
  }
}

async function executeGrep(
  command: string,
  pattern: string,
  cwd: string,
  registration: Registration,
  timeoutMs: number,
): Promise<ExecResult> {
  // Safety check first (shared logic)
  const verdict = safetyCheck(command, cwd, registration);
  if (verdict.kind !== "ok") {
    await writeAuditLog({ command, pattern, cwd, status: "rejected", reason: verdict.kind });
    return {
      content: [{ type: "text" as const, text: verdictToMessage(verdict, cwd) }],
      isError: true,
    };
  }

  try {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      return {
        content: [{ type: "text" as const, text: `Chyba: neplatný regulárny výraz — ${pattern}` }],
        isError: true,
      };
    }

    const { stdout, stderr } = await execAsync(withUtf8Encoding(command), getExecOptions(cwd, timeoutMs));

    const rawOutput = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
    const fullOutput = stripAnsi(rawOutput);
    const lines = parseLines(fullOutput);
    const matches = lines.filter((line) => regex.test(line));

    if (matches.length === 0) {
      return {
        content: [{ type: "text" as const, text: "(žiadna zhoda)" }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Nájdených ${matches.length} zhôd:\n\n${matches.join("\n")}`,
        },
      ],
    };
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Chyba: ${formatCommandError(rawMessage)}` }],
      isError: true,
    };
  }
}

const CWD_GUIDANCE =
  "If the task targets a project other than the primary one (MCP_PROJECT_ROOT), always pass the \"cwd\" parameter. " +
  "Get the list of allowed roots via the \"list_allowed_roots\" tool.";

const cwdSchema = z
  .string()
  .describe(
    "The directory in which the command will be run (must be inside MCP_PROJECT_ROOT / MCP_EXTRA_ROOTS). " +
    "Default: the primary project (MCP_PROJECT_ROOT).",
  );

/** Optional timeout override: 1 s – 10 min (default 60 s). */
const timeoutMsSchema = z
  .number()
  .int()
  .min(1_000)
  .max(600_000)
  .default(60_000)
  .describe("Timeout in milliseconds (1,000 – 600,000, default 60,000). You can extend it for longer tests/builds, e.g. 180,000 for jest.");

async function resolveToolCwd(
  cwd: string | undefined,
): Promise<{ ok: true; cwd: string; registration: Registration } | { ok: false; error: string }> {
  // A bare token (no path separators) that exactly matches a friendly project
  // name is translated to its real path.
  const bare = cwd?.trim() ?? "";
  if (bare && !bare.includes("\\") && !bare.includes("/")) {
    const alias = findAliasByName(bare);
    if (alias) cwd = alias.path;
  }

  const resolved = resolveCwdRequested(cwd);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  // A non-existent cwd makes child_process fail with `spawn cmd.exe ENOENT`
  // (it cannot even spawn cmd). Fail early with a clear message instead.
  try {
    const st = await stat(resolved.cwd);
    if (!st.isDirectory()) {
      return {
        ok: false,
        error:
          `'${resolved.cwd}' nie je adresár.\n` +
          `cwd musí ukazovať na existujúci adresár v rámci povolených koreňov.`,
      };
    }
  } catch {
    return {
      ok: false,
      error:
        `Adresár '${resolved.cwd}' neexistuje.\n` +
        `Relatívne cwd sa rieši voči primárnemu projektu (MCP_PROJECT_ROOT). ` +
        `Pre prácu v inom projekte zadaj absolútnu cestu alebo friendly name ` +
        `(zoznam projektov: list_allowed_roots).`,
    };
  }

  return { ok: true, cwd: resolved.cwd, registration: resolved.registration };
}

// ── Tool: run_safe_command ─────────────────────────────────

server.tool(
  "run_safe_command",
  "Executes a safe command inside the project folder. " +
  "This is the default command execution tool — use it whenever you are not sure whether a command is dangerous. " +
  "Commands outside the project or that look dangerous are rejected automatically. " +
  "If the tool returns isError:true with a rejection message (dangerous or directory_escape), " +
  "DO NOT try to bypass it by rewriting the command or immediately switching to run_destructive_command " +
  "without asking the user first. " +
  "For dangerous operations use run_destructive_command with confirm:true. " +
  "NOTE: 60s limit (optionally extend via timeoutMs) — not suitable for dev servers / watch mode. " +
  "Run test suites (jest/npm test), typecheck and builds through this tool or run_command_grep, NOT through the built-in terminal. " +
  CWD_GUIDANCE,
  {
    command: z.string().describe("The command to execute (runs in the directory given by the cwd parameter)"),
    cwd: cwdSchema.optional(),
    maxLines: z.number().default(200).describe("Maximum number of output lines (default: 200)"),
    timeoutMs: timeoutMsSchema,
  },
  async ({ command, cwd, maxLines, timeoutMs }) => {
    const resolved = await resolveToolCwd(cwd);
    if (!resolved.ok) {
      return {
        content: [{ type: "text" as const, text: `Chyba: ${resolved.error}` }],
        isError: true,
      };
    }
    return executeCommand(command, resolved.cwd, resolved.registration, maxLines, false, timeoutMs);
  },
);

// ── Tool: run_destructive_command ──────────────────────────

server.tool(
  "run_destructive_command",
  "Use ONLY when run_safe_command rejected the command AND the user explicitly confirmed in the chat that they want to run it despite the risk. " +
  "NEVER set confirm:true automatically in reaction to a rejection from run_safe_command. " +
  "First restate the risk to the user in your own words (exactly what the command will do and what it could break) " +
  "and wait for their explicit 'yes' or 'I confirm' in the next message. " +
  "If the user is not present in the conversation (e.g. an automated run without a human), do not use this tool at all. " +
  "EXAMPLE: If the user says 'do it' for a general task and you then hit a dangerous rejection, " +
  "that is not sufficient confirmation — you must explain the specific risk and get a new explicit confirmation. " +
  CWD_GUIDANCE,
  {
    command: z.string().describe("The command to execute (runs in the directory given by the cwd parameter)"),
    confirm: z.boolean().default(false).describe("Confirmation that you are aware of the risk (required for dangerous commands)"),
    cwd: cwdSchema.optional(),
    maxLines: z.number().default(200).describe("Maximum number of output lines (default: 200)"),
    timeoutMs: timeoutMsSchema,
  },
  async ({ command, cwd, maxLines, confirm, timeoutMs }) => {
    const resolved = await resolveToolCwd(cwd);
    if (!resolved.ok) {
      return {
        content: [{ type: "text" as const, text: `Chyba: ${resolved.error}` }],
        isError: true,
      };
    }
    return executeCommand(command, resolved.cwd, resolved.registration, maxLines, confirm, timeoutMs);
  },
);

// ── Tool: read_log_slice ───────────────────────────────────

server.tool(
  "read_log_slice",
  "Reads a slice of a log file by the given line range. " +
  "Use this tool instead of re-running the same command with a higher maxLines " +
  "when you already have the log path saved from a previous run_safe_command / run_destructive_command response. " +
  "NOTE: the file is read directly via Node.js (not through the shell), so it also works for logs in os.tmpdir().",
  {
    logPath: z.string().describe("Path to the log file"),
    startLine: z.number().default(0).describe("Starting line (0-based, default: 0)"),
    lineCount: z.number().default(100).describe("Number of lines to read (default: 100)"),
  },
  async ({ logPath, startLine, lineCount }) => {
    try {
      // Defensive: old logs written before the normalization may still
      // contain ANSI color codes.
      const content = stripAnsi(await readFile(logPath, "utf-8"));
      const lines = parseLines(content);
      const totalLines = lines.length;

      const safeStart = Math.max(0, Math.min(startLine, totalLines - 1));
      const actualEnd = Math.min(safeStart + lineCount, totalLines);
      const slice = lines.slice(safeStart, actualEnd);

      // `totalLines` is always ≥ 1 (an empty file splits into [""]), but guard
      // against a defensive 0 so the header never shows a negative end line.
      const lastShown = Math.max(0, actualEnd - 1);
      const result =
        `[Súbor: ${logPath}, celkovo ${totalLines} riadkov, zobrazené ${safeStart}–${lastShown}]\n\n` +
        slice.join("\n");

      return {
        content: [{ type: "text" as const, text: result }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: `Chyba pri čítaní súboru: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ── Tool: run_command_grep ─────────────────────────────────

server.tool(
  "run_command_grep",
  "Runs a command and returns only lines matching the given pattern (case-insensitive regex). " +
  "Use instead of run_safe_command when you know in advance that the output will be long and you only care about a specific pattern " +
  "(e.g. searching for 'error' in build output, finding a specific test in test runner output). " +
  "The command runs in the directory given by the cwd parameter and is subject to the same safety checks as run_safe_command. " +
  "This is the replacement for Unix 'grep' on Windows — filtering happens in-process, so grep/head/tail are not needed. " +
  "LIMITATION: The matches themselves can be too long — if you need more control, use run_safe_command first " +
  "and then read_log_slice on the saved log file. " +
  "Instead of Unix patterns like 'cmd /c ... | findstr ... & echo DONE' use THIS tool with a pattern — it filters in-process. " +
  CWD_GUIDANCE,
  {
    command: z.string().describe("Command to execute"),
    pattern: z.string().describe("Pattern (regular expression) to filter lines"),
    cwd: cwdSchema.optional(),
    timeoutMs: timeoutMsSchema,
  },
  async ({ command, pattern, cwd, timeoutMs }) => {
    const resolved = await resolveToolCwd(cwd);
    if (!resolved.ok) {
      return {
        content: [{ type: "text" as const, text: `Chyba: ${resolved.error}` }],
        isError: true,
      };
    }
    return executeGrep(command, pattern, resolved.cwd, resolved.registration, timeoutMs);
  },
);

// ── Tool: list_allowed_roots ───────────────────────────────

server.tool(
  "list_allowed_roots",
  "Returns the allowed-roots configuration of this MCP server: the primary project (MCP_PROJECT_ROOT), " +
  "all registered roots (MCP_EXTRA_ROOTS, including globs), the existing projects under them " +
  "(the list of directories you can use as \"cwd\") and whether MCP_BLOCK_CROSS_ROOT_READS is enabled. " +
  "Use THIS tool whenever you need to find out whether — and with which \"cwd\" parameter — you can run a command " +
  "in another project. It runs no commands — it only reads the configuration and lists directories. " +
  "A project with a friendly name is shown as { path, name } and you can pass its \"name\" as \"cwd\".",
  {},
  async () => {
    const projects = await findAllowedProjects();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              primary: ALLOWED_ROOTS[0] ?? null,
              roots: ALLOWED_ROOTS,
              projects,
              blockCrossRootReads: BLOCK_CROSS_ROOT_READS,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ── Tool: resolve_cwd ──────────────────────────────────────

server.tool(
  "resolve_cwd",
  "Verifies whether the given path (or a friendly project name) is inside the allowed roots of this MCP server " +
  "and returns the exact \"cwd\" to use for running commands. Use this tool when you need to find out whether — and with which " +
  "\"cwd\" — you can work in a specific project (e.g. your workspace folder). " +
  "On success: { ok: true, cwd, matchedRoot, name? }; on failure: { ok: false, error, roots }. " +
  "Runs no commands — it only validates the configuration.",
  {
    path: z.string().describe("Path or friendly project name to verify"),
  },
  async ({ path: requestedPath }) => {
    // Friendly name → real path (bare token matching MCP_PROJECT_NAMES).
    let target = requestedPath;
    const bare = requestedPath.trim();
    if (!bare.includes("\\") && !bare.includes("/")) {
      const alias = findAliasByName(bare);
      if (alias) target = alias.path;
    }

    const resolved = resolveCwdRequested(target);
    if (!resolved.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: false,
                requested: requestedPath,
                error: resolved.error,
                primary: ALLOWED_ROOTS[0] ?? null,
                roots: ALLOWED_ROOTS,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    let exists = false;
    try {
      const st = await stat(resolved.cwd);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }

    const alias = findAliasByPath(resolved.cwd);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: true,
              requested: requestedPath,
              cwd: resolved.cwd,
              matchedRoot: resolved.registration.entry,
              exists,
              ...(alias ? { name: alias.name } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ── Tool: universal_find_references ────────────────────────

server.tool(
  "universal_find_references",
  "Find all occurrences of a symbol across a workspace. Structured output with file, line, column, context. " +
  "Optional language-aware mode (rust/typescript/python/cpp) adds role annotations: declaration, import, or usage. " +
  "Use this tool BEFORE any refactoring session to understand what will break when a symbol is renamed or moved.",
  {
    symbol: z.string().describe("Symbol to search for (word-boundary match)"),
    cwd: z.string().optional().describe("Workspace root to search (default: primary project root)"),
    fileExtensions: z.array(z.string()).optional().describe("Restrict to these extensions (default: common source extensions)"),
    excludePatterns: z.array(z.string()).optional().describe("Directories to skip (default: .git, node_modules, target, build, dist, __pycache__)"),
    contextLines: z.number().optional().describe("Lines of context around each match (default: 1)"),
    language: z.enum(["rust", "typescript", "python", "cpp"]).optional().describe("Optional language-aware mode for role detection"),
  },
  async ({ symbol, cwd, fileExtensions, excludePatterns, contextLines, language }) => {
    // Resolve cwd — when not specified, search ALL allowed roots
    let resolvedCwd = cwd;
    let registration: Registration | undefined;
    if (cwd) {
      const bare = cwd.trim();
      let target = cwd;
      if (!bare.includes("\\") && !bare.includes("/")) {
        const alias = findAliasByName(bare);
        if (alias) target = alias.path;
      }
      const resolved = resolveCwdRequested(target);
      if (!resolved.ok) {
        return {
          ...textResult(`**Error:** ${resolved.error}`),
          isError: true,
        };
      }
      resolvedCwd = resolved.cwd;
      registration = resolved.registration;
    }

    // Search: single root or all roots
    const roots = resolvedCwd ? [resolvedCwd] : ALLOWED_ROOTS;
    const seenFiles = new Set<string>();
    const mergedFiles: FileReferences[] = [];
    let totalMatches = 0;

    for (const root of roots) {
      const result = universalFindReferences(symbol, root, {
        fileExtensions,
        excludePatterns,
        contextLines,
        language,
      });
      for (const f of result.files) {
        if (!seenFiles.has(f.file)) {
          seenFiles.add(f.file);
          mergedFiles.push(f);
        }
      }
      totalMatches += result.totalMatches;
    }

    // Audit log
    await writeAuditLog({ tool: "universal_find_references", symbol, cwd: resolvedCwd ?? "all_roots", totalMatches });

    // Format output as readable text
    const out: string[] = [`Symbol: ${symbol}`, `Total matches: ${totalMatches}`, ""];
    for (const f of mergedFiles) {
      out.push(f.file + ":");
      for (const m of f.matches) {
        const role = m.role ? ` [${m.role}]` : "";
        out.push(`  Line ${m.line}:${m.column}${role} — ${m.context.trim()}`);
      }
      out.push("");
    }
    if (mergedFiles.length === 0) out.push("(no matches found)");

    return textResult(out.join("\n"));
  },
);

// ── Tool: extract_code_block ───────────────────────────────

server.tool(
  "extract_code_block",
  "Read the full text of a function, struct, class, or method from a file. Returns precise line range + content. " +
  "Includes leading annotations (#[derive], @decorator, /// doc comments). " +
  "String/comment-aware bracket matching prevents false depth counts from braces inside strings or comments.",
  {
    file: z.string().describe("Source file path (absolute or relative to cwd)"),
    symbol: z.string().describe("Symbol name to extract"),
    contextLines: z.number().optional().describe("Extra lines before/after the block (default: 0)"),
    cwd: z.string().optional().describe("Working directory for resolving relative file paths (default: primary project root)"),
  },
  async ({ file, symbol, contextLines, cwd }) => {
    // Resolve relative file paths against cwd or primary root
    const fileResult = resolveFilePath(file, cwd);
    if (!fileResult.ok) {
      return { content: [{ type: "text" as const, text: `Error: ${fileResult.error}` }], isError: true };
    }
    const resolvedFile = fileResult.filePath;
    const result = extractCodeBlock(resolvedFile, symbol, { contextLines });

    await writeAuditLog({ tool: "extract_code_block", file: resolvedFile, symbol });

    // Format output as readable text
    if ("error" in result) {
      return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
    }
    if ("matches" in result) {
      const out: string[] = [`Symbol: ${symbol} — ${result.matches.length} matches in ${resolvedFile}`, ""];
      for (const m of result.matches) {
        out.push(`--- Lines ${m.startLine}-${m.endLine} ---`);
        out.push(m.text);
        out.push("");
      }
      return { content: [{ type: "text" as const, text: out.join("\n") }] };
    }
    return {
      content: [{ type: "text" as const, text: `${result.file}:${result.startLine}-${result.endLine}\n${result.text}` }],
    };
  },
);

// ── Tool: split_file_by_declarations ───────────────────────

server.tool(
  "split_file_by_declarations",
  "Split a large file into multiple smaller files based on top-level declarations. " +
  "Optionally generates a combining file (mod.rs / index.ts / __init__.py). " +
  "Use dryRun: true (default) to preview the layout before writing.",
  {
    file: z.string().describe("Source file to split"),
    grouping: z.array(z.object({
      module: z.string().describe("Target filename (e.g. data.rs)"),
      symbols: z.array(z.string()).describe("Symbol names to include in this module"),
    })).describe("Module groupings"),
    targetDir: z.string().optional().describe("Where new files are written (default: dirname of file)"),
    language: z.enum(["rust", "typescript", "python", "cpp"]).optional().describe("Language (auto-detected from extension)"),
    generateIndex: z.boolean().optional().describe("Create combining file (default: true)"),
    dryRun: z.boolean().optional().describe("Preview only — write nothing (default: true)"),
    overwrite: z.boolean().optional().describe("Allow overwriting existing target files (default: false)"),
    cwd: z.string().optional().describe("Working dir for resolving relative file paths (default: primary project root)"),
  },
  async (params) => {
    const { grouping, language, generateIndex, dryRun, overwrite, cwd } = params;
    // Resolve relative file paths against cwd or primary root
    const fileResult = resolveFilePath(params.file, cwd);
    if (!fileResult.ok) {
      return { content: [{ type: "text" as const, text: `Error: ${fileResult.error}` }], isError: true };
    }
    let file = fileResult.filePath;
    let targetDir = params.targetDir;
    if (targetDir) {
      const dirResult = resolveFilePath(targetDir, cwd);
      if (!dirResult.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${dirResult.error}` }], isError: true };
      }
      targetDir = dirResult.filePath;
    }
    const result = splitFileByDeclarations(file, grouping, { targetDir, language, generateIndex, dryRun, overwrite });
    await writeAuditLog({ tool: "split_file_by_declarations", file, dryRun: dryRun ?? true, modules: grouping.length });
    if ("error" in result) {
      return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
    }
    const out: string[] = [`${result.dryRun ? "DRY RUN" : "Applied"}: ${result.sourceFile} (${result.language})`, ""];
    if (result.imports) out.push(`Imports (${result.imports.length}):`, ...result.imports, "");
    for (const p of result.preview) {
      const impl = p.implBlocks ? ` + ${p.implBlocks} impl blocks` : "";
      out.push(`${p.module}: [${p.symbols.join(", ")}]${impl} → ${p.targetFile}`);
    }
    if (result.indexFile) out.push("", `Index: ${result.indexFile}`);
    return { content: [{ type: "text" as const, text: out.join("\n") }] };
  },
);

// ── Tool: batch_apply_edits ────────────────────────────────

server.tool(
  "batch_apply_edits",
  "Apply multiple file edits atomically with rollback on failure. " +
  "Validates all edits first — if any search string is not found, NO files are modified. " +
  "Use dryRun: true (default) to preview changes.",
  {
    edits: z.array(z.object({
      file: z.string().describe("File path inside allowed root"),
      search: z.string().describe("Exact text to find (must match once unless replaceAll: true)"),
      replace: z.string().describe("Replacement text"),
      description: z.string().optional().describe("Human-readable description for audit log"),
      replaceAll: z.boolean().optional().describe("Allow multiple matches (default: false)"),
    })).describe("List of edits to apply"),
    dryRun: z.boolean().optional().describe("Preview all changes without writing (default: true)"),
    cwd: z.string().optional().describe("Working dir for resolving relative file paths (default: primary project root)"),
  },
  async ({ edits, dryRun, cwd }) => {
    // Resolve relative file paths against cwd or primary root
    const resolvedEdits = [];
    for (const edit of edits) {
      const fileResult = resolveFilePath(edit.file, cwd);
      if (!fileResult.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${fileResult.error}` }], isError: true };
      }
      resolvedEdits.push({ ...edit, file: fileResult.filePath });
    }
    const result = batchApplyEdits(resolvedEdits, { dryRun });
    await writeAuditLog({ tool: "batch_apply_edits", totalEdits: edits.length, dryRun: dryRun ?? true });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: generate_module_skeleton ─────────────────────────

server.tool(
  "generate_module_skeleton",
  "Generate a new module file with correct imports, declarations and visibility. " +
  "Reads the source file, extracts the specified symbols, and writes them to the target module path. " +
  "Returns error with unknownSymbols list if any symbols are not found.",
  {
    modulePath: z.string().describe("Target file path (e.g. src/ai/data.rs)"),
    symbols: z.array(z.string()).describe("Symbol names to include"),
    sourceFile: z.string().describe("Original file to extract symbols from"),
    language: z.enum(["rust", "typescript", "python"]).optional().describe("Language (auto-detected)"),
    dryRun: z.boolean().optional().describe("Preview only (default: true)"),
    overwrite: z.boolean().optional().describe("Allow overwriting existing file (default: false)"),
    cwd: z.string().optional().describe("Working dir for resolving relative file paths (default: primary project root)"),
  },
  async (params) => {
    const { symbols, language, dryRun, overwrite, cwd } = params;
    // Resolve relative file paths against cwd or primary root
    const moduleResult = resolveFilePath(params.modulePath, cwd);
    if (!moduleResult.ok) {
      return { content: [{ type: "text" as const, text: `Error: ${moduleResult.error}` }], isError: true };
    }
    const sourceResult = resolveFilePath(params.sourceFile, cwd);
    if (!sourceResult.ok) {
      return { content: [{ type: "text" as const, text: `Error: ${sourceResult.error}` }], isError: true };
    }
    const modulePath = moduleResult.filePath;
    const sourceFile = sourceResult.filePath;
    const result = generateModuleSkeleton(modulePath, symbols, sourceFile, { language, dryRun, overwrite });
    await writeAuditLog({ tool: "generate_module_skeleton", modulePath, symbols, dryRun: dryRun ?? true });
    if ("error" in result) {
      const unknowns = "unknownSymbols" in result && result.unknownSymbols ? `\nUnknown: ${result.unknownSymbols.join(", ")}` : "";
      return { content: [{ type: "text" as const, text: `Error: ${result.error}${unknowns}` }], isError: true };
    }
    const out = [
      `${result.dryRun ? "DRY RUN" : "Applied"}: ${result.modulePath} (${result.language})`,
      "",
      result.content,
    ];
    return { content: [{ type: "text" as const, text: out.join("\n") }] };
  },
);

// ── Tool: verify_refactor_safety ───────────────────────────

server.tool(
  "verify_refactor_safety",
  "Semantic diff between old and new code. Catches accidental deletions before compilation. " +
  "Checks: function count, signatures, export count, imports, comment ratio. " +
  "Intentionally conservative — renames appear as errors requiring explicit confirmation.",
  {
    before: z.string().describe("Original code text"),
    after: z.string().describe("New code text"),
    language: z.enum(["rust", "typescript", "python", "cpp"]).optional().describe("Language (auto-detected from content)"),
  },
  async ({ before, after, language }) => {
    const result = verifyRefactorSafety(before, after, { language });
    await writeAuditLog({ tool: "verify_refactor_safety", safe: result.safe, checksCount: result.checks.length });
    const out: string[] = [`Result: ${result.safe ? "SAFE" : "CHANGES DETECTED"}`, ""];
    for (const c of result.checks) {
      const icon = c.status === "error" ? "❌" : (c.status === "warning" ? "⚠️" : "ℹ️");
      const nums = c.before !== undefined ? ` (${c.before} → ${c.after})` : "";
      out.push(`${icon} ${c.check}${nums} — ${c.detail}`);
    }
    return { content: [{ type: "text" as const, text: out.join("\n") }] };
  },
);

// ── Tool: report_tool_feedback ─────────────────────────────

server.tool(
  "report_tool_feedback",
  "Report a bug, improvement, or feature request about any MCP tool in this server. " +
  "Writes structured feedback to .mcp/FEEDBACK.md (project-specific, gitignored). " +
  "Use this when a tool produces unexpected results, crashes, or when you need a new capability. " +
  "Entries are idempotent — duplicate reports are skipped.",
  {
    type: z.enum(["bug", "improvement", "feature_request"]).describe("Type of feedback"),
    tool: z.string().describe("Name of the MCP tool this feedback is about"),
    title: z.string().describe("Short summary (1 line)"),
    description: z.string().describe("Detailed description of the issue or request"),
    reproduction: z.string().optional().describe("Steps to reproduce the issue"),
    expected: z.string().optional().describe("What you expected to happen"),
    suggestion: z.string().optional().describe("Your suggestion for a fix or improvement"),
  },
  async (input) => {
    const root = ALLOWED_ROOTS[0] ?? process.cwd();
    const result = reportToolFeedback(root, "majrooo-mcp-devkit", "majrooo-mcp-devkit", getPackageVersion(), input);
    await writeAuditLog({ tool: "report_tool_feedback", type: input.type, reportedTool: input.tool, result: "error" in result ? "error" : result.written ? "written" : "duplicate" });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: list_feedback ────────────────────────────────────

server.tool(
  "list_feedback",
  "List feedback entries from .mcp/FEEDBACK.md. Optionally filter by type, tool name, or status. " +
  "Use this to check existing feedback before creating new entries, or to review reported issues.",
  {
    type: z.enum(["bug", "improvement", "feature_request"]).optional().describe("Filter by feedback type"),
    tool: z.string().optional().describe("Filter by tool name"),
    status: z.enum(["open", "closed"]).optional().describe("Filter by status"),
  },
  async (filters) => {
    const root = ALLOWED_ROOTS[0] ?? process.cwd();
    const entries = readFeedbackEntries(root, filters);
    await writeAuditLog({ tool: "list_feedback", filters, resultCount: entries.length });
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ total: entries.length, entries }, null, 2) }],
    };
  },
);

// ── Tool: close_feedback ─────────────────────────────────

server.tool(
  "close_feedback",
  "Close an existing feedback entry by ID — sets status to \"closed\" and optionally adds resolution text. " +
  "Use this to mark feedback items as resolved after fixing them.",
  {
    id: z.string().describe("The feedback entry ID to close (from list_feedback output)"),
    resolution: z.string().optional().describe("Resolution note explaining how the issue was addressed"),
  },
  async ({ id, resolution }) => {
    const root = ALLOWED_ROOTS[0] ?? process.cwd();
    const result = closeFeedback(root, id, resolution);
    await writeAuditLog({ tool: "close_feedback", id, resolution: resolution ?? null });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ── Tool registry (for list_tools / help_tool) ──────────────

// Register tools with their actual Zod schemas for accurate introspection.
// Descriptions are passed explicitly for params that use z.any() or enums
// where Zod v4 introspection may not surface .describe() correctly.

// Command tools
registerToolInfo("run_safe_command", "Execute a shell command restricted to the active project root. Default tool — always use first.",
  z.object({
    command: z.string().describe("The command to execute (runs in the directory given by the cwd parameter)"),
    cwd: z.string().optional().describe("The directory in which the command will be run (must be inside MCP_PROJECT_ROOT / MCP_EXTRA_ROOTS). Default: the primary project (MCP_PROJECT_ROOT)."),
    maxLines: z.number().optional().describe("Maximum number of output lines (default: 200)"),
    timeoutMs: z.number().optional().describe("Timeout in milliseconds (1,000 – 600,000, default 60,000)."),
  }),
);
registerToolInfo("run_destructive_command", "Use ONLY when run_safe_command rejected the command AND the user explicitly confirmed. Never set confirm:true automatically. First restate the risk to the user.",
  z.object({
    command: z.string().describe("The command to execute (runs in the directory given by the cwd parameter)"),
    confirm: z.boolean().describe("Confirmation that you are aware of the risk (required for dangerous commands)"),
    cwd: z.string().optional().describe("The directory in which the command will be run (must be inside MCP_PROJECT_ROOT / MCP_EXTRA_ROOTS). Default: the primary project (MCP_PROJECT_ROOT)."),
    maxLines: z.number().optional().describe("Maximum number of output lines (default: 200)"),
    timeoutMs: z.number().optional().describe("Timeout in milliseconds (1,000 – 600,000, default 60,000)."),
  }),
);
registerToolInfo("read_log_slice", "Reads a slice of a log file by the given line range. Use instead of re-running the same command with a higher maxLines.",
  z.object({
    logPath: z.string().describe("Path to the log file"),
    startLine: z.number().optional().describe("Starting line (0-based, default: 0)"),
    lineCount: z.number().optional().describe("Number of lines to read (default: 100)"),
  }),
);
registerToolInfo("run_command_grep", "Runs a command and returns only lines matching a given pattern (case-insensitive regex). Replacement for Unix grep on Windows — filtering in-process.",
  z.object({
    command: z.string().describe("Command to execute"),
    pattern: z.string().describe("Pattern (regular expression) to filter lines"),
    cwd: z.string().optional().describe("The directory in which the command will be run (must be inside MCP_PROJECT_ROOT / MCP_EXTRA_ROOTS). Default: the primary project (MCP_PROJECT_ROOT)."),
    timeoutMs: z.number().optional().describe("Timeout in milliseconds (1,000 – 600,000, default 60,000)."),
  }),
);
registerToolInfo("list_allowed_roots", "Returns the allowed-roots configuration: primary project, all registered roots, existing projects under them.",
  z.object({}),
);
registerToolInfo("resolve_cwd", "Verifies whether a path or friendly project name is inside allowed roots. Returns exact cwd to use.",
  z.object({
    path: z.string().describe("Path or friendly project name to verify"),
  }),
);

// Refactoring tools
registerToolInfo("universal_find_references", "Find all occurrences of a symbol across a workspace. Structured output with file, line, column, context. Optional language-aware role detection.",
  z.object({
    symbol: z.string().describe("Symbol to search for (word-boundary match)"),
    cwd: z.string().optional().describe("Workspace root to search (default: primary project root)"),
    fileExtensions: z.array(z.string()).optional().describe("Restrict to these extensions (default: common source extensions)"),
    excludePatterns: z.array(z.string()).optional().describe("Directories to skip (default: .git, node_modules, target, build, dist, __pycache__)"),
    contextLines: z.number().optional().describe("Lines of context around each match (default: 1)"),
    language: z.enum(["rust", "typescript", "python", "cpp"]).optional().describe("Optional language-aware mode for role detection"),
  }),
);
registerToolInfo("extract_code_block", "Read the full text of a function, struct, class, or method from a file. Annotation-aware, string/comment-safe bracket matching.",
  z.object({
    file: z.string().describe("Source file path (absolute or relative to cwd)"),
    symbol: z.string().describe("Symbol name to extract"),
    contextLines: z.number().optional().describe("Extra lines before/after the block (default: 0)"),
    cwd: z.string().optional().describe("Working directory for resolving relative file paths (default: primary project root)"),
  }),
);
registerToolInfo("split_file_by_declarations", "Split a large file into multiple smaller files based on top-level declarations. Use dryRun: true (default) to preview before writing.",
  z.object({
    file: z.string().describe("Source file to split"),
    grouping: z.array(z.object({
      module: z.string().describe("Target filename (e.g. data.rs)"),
      symbols: z.array(z.string()).describe("Symbol names to include in this module"),
    })).describe("Module groupings"),
    language: z.enum(["rust", "typescript", "python", "cpp"]).optional().describe("Language (auto-detected from extension)"),
    targetDir: z.string().optional().describe("Where new files are written (default: dirname of file)"),
    generateIndex: z.boolean().optional().describe("Create combining file (default: true)"),
    dryRun: z.boolean().optional().describe("Preview only — write nothing (default: true)"),
    overwrite: z.boolean().optional().describe("Allow overwriting existing target files (default: false)"),
  }),
);
registerToolInfo("batch_apply_edits", "Apply multiple file edits atomically with rollback on failure. Validates all edits first. Use dryRun: true (default) to preview.",
  z.object({
    edits: z.array(z.object({
      file: z.string().describe("File path inside allowed root"),
      search: z.string().describe("Exact text to find (must match once unless replaceAll: true)"),
      replace: z.string().describe("Replacement text"),
      description: z.string().optional().describe("Human-readable description for audit log"),
      replaceAll: z.boolean().optional().describe("Allow multiple matches (default: false)"),
    })).describe("List of edits to apply"),
    dryRun: z.boolean().optional().describe("Preview all changes without writing (default: true)"),
    cwd: z.string().optional().describe("Working dir for resolving relative file paths (default: primary project root)"),
  }),
);
registerToolInfo("generate_module_skeleton", "Generate a new module file with correct imports, declarations and visibility. Declaration-only filtering.",
  z.object({
    modulePath: z.string().describe("Target file path (e.g. src/ai/data.rs)"),
    symbols: z.array(z.string()).describe("Symbol names to include"),
    sourceFile: z.string().describe("Original file to extract symbols from"),
    language: z.enum(["rust", "typescript", "python"]).optional().describe("Language (auto-detected from extension)"),
    visibility: z.string().optional().describe("Visibility modifier (e.g. pub, pub(crate))"),
    dryRun: z.boolean().optional().describe("Preview only (default: true)"),
    overwrite: z.boolean().optional().describe("Allow overwriting existing file (default: false)"),
  }),
);
registerToolInfo("verify_refactor_safety", "Semantic diff between old and new code. Catches accidental deletions before compilation. Checks: function count, signatures, exports, imports, comment ratio.",
  z.object({
    before: z.string().describe("Original code text"),
    after: z.string().describe("New code text"),
    language: z.enum(["rust", "typescript", "python", "cpp"]).optional().describe("Language (auto-detected from content)"),
  }),
);

// Feedback tools
registerToolInfo("report_tool_feedback", "Report a bug, improvement, or feature request about any MCP tool. Writes structured feedback to .mcp/FEEDBACK.md. Idempotent — duplicate reports are skipped.",
  z.object({
    type: z.enum(["bug", "improvement", "feature_request"]).describe("Type of feedback"),
    tool: z.string().describe("Name of the MCP tool this feedback is about"),
    title: z.string().describe("Short summary (1 line)"),
    description: z.string().describe("Detailed description of the issue or request"),
    reproduction: z.string().optional().describe("Steps to reproduce the issue"),
    expected: z.string().optional().describe("What you expected to happen"),
    suggestion: z.string().optional().describe("Your suggestion for a fix or improvement"),
  }),
);
registerToolInfo("list_feedback", "List feedback entries from .mcp/FEEDBACK.md. Optionally filter by type, tool name, or status.",
  z.object({
    type: z.enum(["bug", "improvement", "feature_request"]).optional().describe("Filter by feedback type"),
    tool: z.string().optional().describe("Filter by tool name"),
    status: z.enum(["open", "closed"]).optional().describe("Filter by status"),
  }),
);
registerToolInfo("close_feedback", "Close an existing feedback entry by ID — sets status to 'closed' and optionally adds resolution text.",
  z.object({
    id: z.string().describe("The feedback entry ID to close (from list_feedback output)"),
    resolution: z.string().optional().describe("Resolution note explaining how the issue was addressed"),
  }),
);

// ── Tool: list_tools ─────────────────────────────────────────

server.tool(
  "list_tools",
  "List all available MCP tools with descriptions. Use this to discover available tools before starting a task.",
  {
    category: z.enum(["command", "refactoring", "feedback"]).optional().describe("Filter by category"),
  },
  async ({ category }) => {
    const tools = listToolInfos(category);
    await writeAuditLog({ tool: "list_tools", category: category ?? "all", resultCount: tools.length });

    const groups: Record<string, typeof tools> = {};
    for (const t of tools) {
      const cat = t.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(t);
    }

    const lines: string[] = [];
    lines.push(`# MCP Tools (${tools.length} total)\n`);

    const categoryLabels: Record<string, string> = {
      command: "Command Tools",
      refactoring: "Refactoring Tools",
      feedback: "Feedback Tools",
    };

    for (const [cat, catTools] of Object.entries(groups)) {
      lines.push(`## ${categoryLabels[cat] ?? cat}\n`);
      for (const t of catTools) {
        const reqParams = t.params.filter((p) => p.required);
        const optParams = t.params.filter((p) => !p.required);
        const sig = reqParams.length > 0
          ? ` — _${reqParams.map((p) => p.name).join(", ")}_`
          : "";
        lines.push(`- **${t.name}**${sig}: ${t.description}`);
        if (optParams.length > 0) {
          for (const p of optParams) {
            const def = p.default !== undefined ? ` (default: \`${p.default}\`)` : "";
            lines.push(`  - _${p.name}_: ${p.description}${def}`);
          }
        }
      }
      lines.push("");
    }

    return textResult(lines.join("\n"));
  },
);

// ── Tool: help_tool ──────────────────────────────────────────

server.tool(
  "help_tool",
  "Get detailed help for a specific MCP tool — parameters, types, defaults, description.",
  {
    tool: z.string().describe("Tool name to get help for"),
  },
  async ({ tool: toolName }) => {
    const info = getToolInfo(toolName);
    if (!info) {
      return {
        ...textResult(`**Error:** Unknown tool: \`${toolName}\``),
        isError: true,
      };
    }
    await writeAuditLog({ tool: "help_tool", helpFor: toolName });

    const lines: string[] = [];
    lines.push(`# ${info.name}\n`);
    lines.push(`${info.description}\n`);
    lines.push(`**Category:** ${info.category}\n`);

    if (info.params.length > 0) {
      lines.push("## Parameters\n");
      lines.push("| Name | Type | Required | Default | Description |");
      lines.push("|------|------|----------|---------|-------------|");
      for (const p of info.params) {
        const req = p.required ? "yes" : "no";
        const def = p.default !== undefined ? `\`${p.default}\`` : "—";
        lines.push(`| \`${p.name}\` | ${p.type} | ${req} | ${def} | ${p.description} |`);
      }
      lines.push("");
    } else {
      lines.push("_No parameters._\n");
    }

    return textResult(lines.join("\n"));
  },
);

// ── Transport ──────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// ── Graceful shutdown ──────────────────────────────────────

function gracefulShutdown(signal: string) {
  console.error(`[server] Received ${signal}, shutting down…`);
  server.close().catch(() => {/* best-effort */});
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ── Global error handlers ──────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
  process.exit(1);
});