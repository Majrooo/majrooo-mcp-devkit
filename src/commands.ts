/*
 * majrooo-mcp-devkit — commands.ts
 * Command execution, safety checks, grep, cwd resolution.
 * Extracted from index.ts (2026-09-12 refactoring).
 */
import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, stat } from "fs/promises";
import path from "path";
import {
  findEscapeReason, isDangerous, resolveCwdRequested,
  findOutOfRootWriteTargets, findSuspiciousCrossRootReads,
  findAliasByName, ALLOWED_ROOTS, BLOCK_CROSS_ROOT_READS,
  extractRedirectTargets, extractDestructiveTargets,
  type Registration,
} from "./safety.js";
import { stripAnsi, withUtf8Encoding } from "./output.js";
import { buildRedirectNote } from "./redirect.js";
import { composeFailureMessage, extractExecFailure, formatCommandError } from "./format.js";
import { getTempLogPath, parseLines, writeAuditLog } from "./helpers.js";

const execAsync = promisify(exec);

export type ExecResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export type SafetyVerdict =
  | { kind: "ok" }
  | { kind: "directory_escape"; reason: string }
  | { kind: "dangerous"; match: string }
  | { kind: "outside_root_write"; targets: { target: string; reason: string }[] }
  | { kind: "cross_root_read"; targets: string[] };

function getExecOptions(cwd: string, timeoutMs: number) {
  return {
    maxBuffer: 1024 * 1024 * 50,
    timeout: timeoutMs,
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  };
}

export function safetyCheck(command: string, cwd: string, registration: Registration): SafetyVerdict {
  const escape = findEscapeReason(command);
  if (escape) return { kind: "directory_escape", reason: escape };
  const dangerous = isDangerous(command);
  if (dangerous) return { kind: "dangerous", match: dangerous };
  const writes = findOutOfRootWriteTargets(command, cwd, registration);
  if (writes.length > 0) return { kind: "outside_root_write", targets: writes };
  if (BLOCK_CROSS_ROOT_READS) {
    const reads = findSuspiciousCrossRootReads(command, cwd, registration);
    if (reads.length > 0) return { kind: "cross_root_read", targets: reads };
  }
  return { kind: "ok" };
}


async function findMissingDestructiveTargets(command: string, cwd: string): Promise<string[]> {
  const missing: string[] = [];
  for (const raw of extractDestructiveTargets(command)) {
    const cleaned = raw.replace(/^[\"']|[\"']$/g, "");
    if (cleaned.includes("$") || cleaned.includes("%")) continue;
    if (cleaned.includes("*") || cleaned.includes("?")) continue;
    const resolved = path.resolve(cwd, cleaned);
    try { await stat(resolved); } catch { missing.push(`${cleaned} (${resolved})`); }
  }
  return missing;
}

function buildMissingTargetMessage(missingTargets: string[], cwd: string): string {
  const rootList = ALLOWED_ROOTS.map((r) => `  - ${r}`).join("\n");
  return [
    `Príkaz odmietnutý — cieľ destruktívneho príkazu neexistuje v aktívnom projektovom koreni.`,
    `Aktívny koreň (cwd): ${cwd}`, ``,
    `Chýbajúce ciele:`, ...missingTargets.map((t) => `  - ${t}`), ``,
    `Pravdepodobne chýba/nesedí parameter "cwd".`,
    `Prepni projekt cez parameter "cwd" alebo si pozri povolené korene cez "list_allowed_roots":`, rootList,
  ].join("\n");
}

export function verdictToMessage(verdict: Exclude<SafetyVerdict, { kind: "ok" }>, activeRoot: string): string {
  const rootList = ALLOWED_ROOTS.map((r) => `  - ${r}`).join("\n");
  switch (verdict.kind) {
    case "directory_escape":
      return [`Príkaz odmietnutý — pokus o opustenie aktívneho projektového koreňa.`, `Zistený vzor: ${verdict.reason}`, ``, `Aktívny koreň (cwd): ${activeRoot}`, `Povolené korene:`, rootList].join("\n");
    case "dangerous":
      return [`⚠️  Príkaz bol označený ako potenciálne nebezpečný!`, `   Zhoda so vzorom: ${verdict.match}`, ``, `Ak si si istý, použij "run_destructive_command" s "confirm: true".`].join("\n");
    case "outside_root_write":
      return [`Príkaz odmietnutý — zápis mimo aktívneho projektového koreňa.`, `Aktívny koreň (cwd): ${activeRoot}`, ``, `Zachytené ciele zápisu:`, ...verdict.targets.map((t) => `  - ${t.target} (${t.reason})`)].join("\n");
    case "cross_root_read":
      return [`Príkaz odmietnutý — čítanie mimo aktívneho projektového koreňa.`, `Aktívny koreň (cwd): ${activeRoot}`, ``, `Zachytené ciele čítania:`, ...verdict.targets.map((t) => `  - ${t}`)].join("\n");
  }
}

export async function executeCommand(
  command: string, cwd: string, registration: Registration,
  maxLines: number, confirm: boolean, timeoutMs: number,
): Promise<ExecResult> {
  const verdict = safetyCheck(command, cwd, registration);
  if (verdict.kind !== "ok") {
    if (!confirm) {
      await writeAuditLog({ command, cwd, status: "rejected", reason: verdict.kind });
      return { content: [{ type: "text" as const, text: verdictToMessage(verdict, cwd) }], isError: true };
    }
    console.error(`[DESTRUCTIVE] cwd=${cwd} ${command} (confirmed)`);
  }

  try {
    const missingTargets = await findMissingDestructiveTargets(command, cwd);
    if (missingTargets.length > 0) {
      await writeAuditLog({ command, cwd, status: "rejected", reason: "missing_destructive_target", confirm });
      return { content: [{ type: "text" as const, text: buildMissingTargetMessage(missingTargets, cwd) }], isError: true };
    }

    const safeMax = Math.max(1, maxLines);
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
      content = `[Výstup orezaný — celkovo ${totalLines} riadkov]\n[Plný výstup uložený v: ${logPath}]\n\n${lines.slice(0, half).join("\n")}\n...\n${lines.slice(totalLines - half).join("\n")}`;
    }

    const redirectTargets = extractRedirectTargets(command);
    const redirectNote = await buildRedirectNote(redirectTargets, cwd, maxLines);
    if (redirectNote) content = content.trim() ? `${content}\n\n${redirectNote}` : redirectNote;

    await writeAuditLog({ command, cwd, status: "ok", confirm });
    return { content: [{ type: "text" as const, text: content }] };
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const details = extractExecFailure(error);
    const redirectTargets = extractRedirectTargets(command);
    const redirectNote = await buildRedirectNote(redirectTargets, cwd, maxLines);
    const message = composeFailureMessage({ rawError: rawMessage, command, cwd, details, maxLines, redirectNote });
    await writeAuditLog({ command, cwd, status: "error", error: rawMessage, confirm });
    return { content: [{ type: "text" as const, text: `Chyba: ${message}` }], isError: true };
  }
}

export async function executeGrep(
  command: string, pattern: string, cwd: string,
  registration: Registration, timeoutMs: number,
): Promise<ExecResult> {
  const verdict = safetyCheck(command, cwd, registration);
  if (verdict.kind !== "ok") {
    await writeAuditLog({ command, pattern, cwd, status: "rejected", reason: verdict.kind });
    return { content: [{ type: "text" as const, text: verdictToMessage(verdict, cwd) }], isError: true };
  }
  try {
    let regex: RegExp;
    try { regex = new RegExp(pattern, "i"); } catch {
      return { content: [{ type: "text" as const, text: `Chyba: neplatný regulárny výraz — ${pattern}` }], isError: true };
    }
    const { stdout, stderr } = await execAsync(withUtf8Encoding(command), getExecOptions(cwd, timeoutMs));
    const fullOutput = stripAnsi(stdout + (stderr ? `\nSTDERR:\n${stderr}` : ""));
    const matches = parseLines(fullOutput).filter((line) => regex.test(line));
    if (matches.length === 0) return { content: [{ type: "text" as const, text: "(žiadna zhoda)" }] };
    return { content: [{ type: "text" as const, text: `Nájdených ${matches.length} zhôd:\n\n${matches.join("\n")}` }] };
  } catch (error: unknown) {
    return { content: [{ type: "text" as const, text: `Chyba: ${formatCommandError(error instanceof Error ? error.message : String(error))}` }], isError: true };
  }
}

export async function resolveToolCwd(
  cwd: string | undefined,
): Promise<{ ok: true; cwd: string; registration: Registration } | { ok: false; error: string }> {
  const bare = cwd?.trim() ?? "";
  if (bare && !bare.includes("\\") && !bare.includes("/")) {
    const alias = findAliasByName(bare);
    if (alias) cwd = alias.path;
  }
  const resolved = resolveCwdRequested(cwd);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  try {
    const st = await stat(resolved.cwd);
    if (!st.isDirectory()) return { ok: false, error: `'${resolved.cwd}' nie je adresár.` };
  } catch {
    return { ok: false, error: `Adresár '${resolved.cwd}' neexistuje. Pre prácu v inom projekte zadaj absolútnu cestu alebo friendly name (zoznam: list_allowed_roots).` };
  }
  return { ok: true, cwd: resolved.cwd, registration: resolved.registration };
}

