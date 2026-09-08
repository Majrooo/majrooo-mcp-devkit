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
  PROJECT_ALIASES,
  extractRedirectTargets,
  extractDestructiveTargets,
  type Registration,
} from "./safety.js";
import { stripAnsi, withUtf8Encoding } from "./output.js";
import { buildRedirectNote } from "./redirect.js";
import { composeFailureMessage, extractExecFailure, formatCommandError } from "./format.js";
import { universalFindReferences, extractCodeBlock, type FileReferences } from "./symbols.js";
import { splitFileByDeclarations } from "./split.js";
import { batchApplyEdits } from "./batch.js";
import { generateModuleSkeleton } from "./skeleton.js";
import { verifyRefactorSafety } from "./verify.js";
import { reportToolFeedback, readFeedbackEntries, closeFeedback } from "./feedback.js";
import { registerToolInfo, listToolInfos, getToolInfo } from "./tool-registry.js";

const execAsync = promisify(exec);

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
  version: "0.1.0",
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
  } catch {
    // Audit log failure should not crash the command
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
          content: [{ type: "text" as const, text: JSON.stringify({ error: resolved.error }, null, 2) }],
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

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ symbol, totalMatches, files: mergedFiles }, null, 2) }],
    };
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
    let resolvedFile = file;
    if (!path.isAbsolute(file)) {
      const basePath = cwd ?? ALLOWED_ROOTS[0] ?? process.cwd();
      resolvedFile = path.resolve(basePath, file);
    }
    const result = extractCodeBlock(resolvedFile, symbol, { contextLines });

    await writeAuditLog({ tool: "extract_code_block", file: resolvedFile, symbol });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
  },
  async ({ file, grouping, targetDir, language, generateIndex, dryRun, overwrite }) => {
    const result = splitFileByDeclarations(file, grouping, { targetDir, language, generateIndex, dryRun, overwrite });
    await writeAuditLog({ tool: "split_file_by_declarations", file, dryRun: dryRun ?? true, modules: grouping.length });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
  },
  async ({ edits, dryRun }) => {
    const result = batchApplyEdits(edits, { dryRun });
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
  },
  async ({ modulePath, symbols, sourceFile, language, dryRun, overwrite }) => {
    const result = generateModuleSkeleton(modulePath, symbols, sourceFile, { language, dryRun, overwrite });
    await writeAuditLog({ tool: "generate_module_skeleton", modulePath, symbols, dryRun: dryRun ?? true });
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
    const result = reportToolFeedback(root, "majrooo-mcp-devkit", "majrooo-mcp-devkit", "0.1.0", input);
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

// Registry helper: register a tool with simplified param definitions
const _regParams = new Map<string, { description: string; params: Array<[string, string, boolean, string?]> }>();

function _registerTool(name: string, desc: string, params: Array<[string, string, boolean, string?]>) {
  const schema = z.object(Object.fromEntries(
    params.map(([n, _t, req, d]) => [n, req ? z.any().describe(d ?? "") : z.any().optional().describe(d ?? "")]),
  ));
  registerToolInfo(name, desc, schema);
}

// Command tools
_registerTool("run_safe_command", "Execute a shell command restricted to the active project root. Default tool — always use first.", [
  ["command", "string", true, "Command to execute"],
  ["cwd", "string", false, "Working directory"],
  ["maxLines", "number", false, "Max output lines (default 200)"],
  ["timeoutMs", "number", false, "Timeout in ms (default 60000)"],
]);
_registerTool("run_destructive_command", "Execute dangerous command after explicit user confirmation.", [
  ["command", "string", true, "Command to execute"],
  ["confirm", "boolean", true, "Acknowledge risk (required)"],
  ["cwd", "string", false, "Working directory"],
]);
_registerTool("read_log_slice", "Read a portion of a saved log file.", [
  ["logPath", "string", true, "Path to the log file"],
  ["startLine", "number", false, "Starting line 0-based (default 0)"],
  ["lineCount", "number", false, "Lines to read (default 100)"],
]);
_registerTool("run_command_grep", "Run command, return only lines matching a regex (Windows grep replacement).", [
  ["command", "string", true, "Command to execute"],
  ["pattern", "string", true, "Regex pattern to filter"],
  ["cwd", "string", false, "Working directory"],
]);
_registerTool("list_allowed_roots", "List registered roots and friendly names usable as cwd.", []);
_registerTool("resolve_cwd", "Verify a path against allowed roots. Returns exact cwd.", [
  ["path", "string", true, "Path or friendly name to verify"],
]);

// Refactoring tools
_registerTool("universal_find_references", "Find all occurrences of a symbol. Without cwd searches ALL allowed roots. Language-aware mode adds role annotations.", [
  ["symbol", "string", true, "Symbol to search for"],
  ["cwd", "string", false, "Workspace root (default: all roots)"],
  ["language", "string", false, "rust|typescript|python|cpp for role detection"],
]);
_registerTool("extract_code_block", "Extract full text of a function/struct/class. Annotation-aware, string/comment-safe bracket matching.", [
  ["file", "string", true, "Source file path (absolute or relative)"],
  ["symbol", "string", true, "Symbol name to extract"],
  ["contextLines", "number", false, "Extra lines (default 0)"],
  ["cwd", "string", false, "Working dir for relative paths"],
]);
_registerTool("split_file_by_declarations", "Split large file into modules based on declarations. Generates index files. Use dryRun first.", [
  ["file", "string", true, "Source file to split"],
  ["grouping", "array", true, "Array of { module, symbols }"],
  ["targetDir", "string", false, "Output directory"],
  ["dryRun", "boolean", false, "Preview only (default true)"],
]);
_registerTool("batch_apply_edits", "Apply multiple file edits atomically with rollback. Validates first. Handles CRLF.", [
  ["edits", "array", true, "Array of { file, search, replace }"],
  ["dryRun", "boolean", false, "Preview only (default true)"],
]);
_registerTool("generate_module_skeleton", "Generate module file by extracting symbols from source. Declaration-only filtering.", [
  ["modulePath", "string", true, "Target file path"],
  ["symbols", "array", true, "Symbol names to extract"],
  ["sourceFile", "string", true, "Source file"],
  ["dryRun", "boolean", false, "Preview only (default true)"],
]);
_registerTool("verify_refactor_safety", "Semantic diff: function count, signatures, exports, imports, comment ratio.", [
  ["before", "string", true, "Original code"],
  ["after", "string", true, "New code"],
]);

// Feedback tools
_registerTool("report_tool_feedback", "Report bugs/improvements/feature requests. Writes to .mcp/FEEDBACK.md. Idempotent.", [
  ["type", "string", true, "bug|improvement|feature_request"],
  ["tool", "string", true, "Tool name"],
  ["title", "string", true, "Short summary"],
  ["description", "string", true, "Detailed description"],
]);
_registerTool("list_feedback", "List feedback entries. Filter by type, tool, status.", [
  ["type", "string", false, "bug|improvement|feature_request"],
  ["tool", "string", false, "Tool name filter"],
  ["status", "string", false, "open|closed"],
]);
_registerTool("close_feedback", "Close feedback entry by ID with resolution text.", [
  ["id", "string", true, "Entry ID"],
  ["resolution", "string", false, "Resolution note"],
]);

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
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ total: tools.length, tools }, null, 2) }],
    };
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
        content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
        isError: true,
      };
    }
    await writeAuditLog({ tool: "help_tool", helpFor: toolName });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
    };
  },
);

// ── Transport ──────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);