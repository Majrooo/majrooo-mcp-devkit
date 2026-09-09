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
// src/format.ts — MCP response helpers + command failure formatting.
//
// `textResult(text)` returns a clean text response for human/agent consumption.
// `jsonResult(data)` returns pretty-printed JSON for structured data.
// Command failure helpers below turn bare exec errors into useful messages.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { stripAnsi } from "./output.js";

/** MCP tool result containing plain text (for human/agent reading). */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/** MCP tool result containing pretty-printed JSON (for structured data). */
export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const WINDOWS_NOT_RECOGNIZED = /'([^']+)' is not recognized as an internal or external command/i;

/** Strip Node's `Command failed: ` prefix — the command is printed separately. */
const COMMAND_FAILED_PREFIX = /^Command failed: /;

export interface ExecFailureDetails {
  /** Process exit code, or null when killed by a signal. */
  exitCode: number | null;
  /** Signal that terminated the process, or null. */
  signal: string | null;
  /** Whether the process was killed (e.g. by the exec timeout). */
  killed: boolean;
  /** stdout captured by exec (empty when the output was redirected to a file). */
  capturedStdout: string;
  /** stderr captured by exec (empty when the output was redirected to a file). */
  capturedStderr: string;
}

/**
 * Extract the structured failure details from an exec rejection.
 * Works for the standard Node child_process error shape and for plain
 * unknown errors (returns empty defaults).
 */
export function extractExecFailure(error: unknown): ExecFailureDetails {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    return {
      exitCode: typeof e.code === "number" ? e.code : null,
      signal: typeof e.signal === "string" ? e.signal : null,
      killed: e.killed === true,
      capturedStdout: typeof e.stdout === "string" ? e.stdout : "",
      capturedStderr: typeof e.stderr === "string" ? e.stderr : "",
    };
  }
  return { exitCode: null, signal: null, killed: false, capturedStdout: "", capturedStderr: "" };
}

/** Human-readable reason: exit code, signal, or timeout. */
export function describeFailure(details: ExecFailureDetails): string {
  if (details.signal) {
    if (details.killed && details.signal === "SIGTERM") {
      return "príkaz bol ukončený kvôli timeoutu (SIGTERM)";
    }
    return `príkaz bol ukončený signálom ${details.signal}`;
  }
  if (details.exitCode !== null) {
    return `exit code ${details.exitCode}`;
  }
  return "neznáma chyba";
}

/**
 * Friendly message for the Windows "not recognized" error.
 * Returns the input unchanged when the pattern does not match.
 */
export function formatCommandError(rawError: string): string {
  const m = WINDOWS_NOT_RECOGNIZED.exec(rawError);
  if (m) {
    const tool = m[1];
    return [
      `Príkaz zlyhal: '${tool}' nie je dostupný príkaz (beží cez Windows cmd).`,
      ``,
      `Toto je typické pre Unixové nástroje (grep, head, tail, ...), ktoré na Windows neexistujú.`,
      ``,
      `Alternatívy:`,
      `  - Filtrovanie výstupu: tool "run_command_grep" (pattern sa aplikuje v procese, funguje na Windows)`,
      `  - Prvých N riadkov: "run_safe_command" + uložený log + "read_log_slice"`,
      `  - PowerShell:  powershell -Command "Get-Content out.log | Select-String 'vzor'"`,
      `  - PowerShell head:  powershell -Command "Get-Content out.log -TotalCount 30"`,
      ``,
      `Chyba: ${rawError}`,
    ].join("\n");
  }
  return rawError;
}

/** Combine stdout/stderr and keep only the last `maxLines` lines. */
export function formatCapturedOutput(stdout: string, stderr: string, maxLines: number): string {
  const raw = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
  if (!raw.trim()) return "";
  const safeMax = Math.max(1, maxLines);
  const lines = stripAnsi(raw).split(/\r?\n/);
  return lines.slice(-safeMax).join("\n");
}

export interface FailureMessageInput {
  /** Raw error message from the exec rejection. */
  rawError: string;
  /** The original user command (without the injected `chcp 65001` prefix). */
  command: string;
  /** Working directory the command ran in. */
  cwd: string;
  /** Structured failure details (exit code, signal, captured output). */
  details: ExecFailureDetails;
  /** Cap for the number of captured/redirect output lines shown. */
  maxLines: number;
  /** Pre-built note about redirected output files, or null. */
  redirectNote: string | null;
}

/**
 * Compose the full failure response shown to the user.
 * Falls back to `formatCommandError` for the "not recognized" case.
 */
export function composeFailureMessage(input: FailureMessageInput): string {
  const lines: string[] = [];

  if (WINDOWS_NOT_RECOGNIZED.test(input.rawError)) {
    lines.push(`Chyba: ${formatCommandError(input.rawError)}`);
  } else {
    const cleaned = input.rawError.replace(COMMAND_FAILED_PREFIX, "").trim() || input.rawError;
    lines.push(`Chyba: ${cleaned}`);
    lines.push(`Príčina: ${describeFailure(input.details)}`);
  }

  lines.push(`Príkaz: ${input.command}`);
  lines.push(`cwd: ${input.cwd}`);

  const captured = formatCapturedOutput(
    input.details.capturedStdout,
    input.details.capturedStderr,
    input.maxLines,
  );
  if (captured) {
    lines.push(`[Zachytený výstup:]`);
    lines.push(captured);
  }

  if (input.redirectNote) {
    lines.push(input.redirectNote);
  }

  return lines.join("\n");
}