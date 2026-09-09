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
// src/safety.ts — Safety rules for command execution
import path from "path";
import { fileURLToPath } from "url";
import { readdir } from "fs/promises";

// ── Allowed roots (project registry) ───────────────────────

function getModuleRoot(): string {
  const modulePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(modulePath), "..");
}

function splitEnvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Registered allowed roots.
 *
 * Supported forms:
 *  - plain path (e.g. `D:\W\TS\majrooo-mcp-devkit`) → prefix: the directory itself
 *    and everything below it are allowed;
 *  - glob (`*`, `**`, `?`, e.g. `D:\W\TS\*`) → any path matching the pattern
 *    (and its subtree) is allowed.
 *
 * Resolution order:
 *  1. `MCP_PROJECT_ROOT` — primary root (default `cwd` when omitted);
 *  2. `MCP_EXTRA_ROOTS` — additional roots, semicolon separated;
 *  3. If `MCP_PROJECT_ROOT` is unset, the server's own directory is used.
 *
 * NOTE: the fallback uses the module location (`import.meta.url`), NOT
 * `process.cwd()` — when hosted by VS Code, `process.cwd()` points to the
 * VS Code install directory, which was the root cause of confusing rejections.
 */
export const ALLOWED_ROOTS: string[] = (() => {
  const primary = process.env.MCP_PROJECT_ROOT?.trim() ?? "";
  const extra = splitEnvList(process.env.MCP_EXTRA_ROOTS);
  const values = primary ? [primary, ...extra] : [getModuleRoot(), ...extra];
  return [...new Set(values.map((p) => path.resolve(p)))];
})();

/** Primary root used as default `cwd` for every command. */
export const PRIMARY_ROOT: string = ALLOWED_ROOTS[0] ?? getModuleRoot();

/** Opt-in heuristic that blocks obvious reads outside the active root. */
export const BLOCK_CROSS_ROOT_READS: boolean =
  process.env.MCP_BLOCK_CROSS_ROOT_READS === "1" ||
  process.env.MCP_BLOCK_CROSS_ROOT_READS?.toLowerCase() === "true";

// ── Friendly project names (MCP_PROJECT_NAMES) ─────────────

export interface ProjectAlias {
  path: string;
  name: string;
}

/**
 * Parse `MCP_PROJECT_NAMES` — semicolon separated `path=name` pairs.
 * Split on the FIRST `=`; entries without a valid pair are skipped.
 * Paths are resolved to absolute, names trimmed.
 */
export function parseProjectAliases(value: string | undefined): ProjectAlias[] {
  if (!value) return [];
  const result: ProjectAlias[] = [];
  for (const pair of value.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) continue;
    const p = trimmed.slice(0, eq).trim();
    const n = trimmed.slice(eq + 1).trim();
    if (p && n) result.push({ path: path.resolve(p), name: n });
  }
  return result;
}

/** Friendly project names from the environment. */
export const PROJECT_ALIASES: ProjectAlias[] = parseProjectAliases(process.env.MCP_PROJECT_NAMES);

/** Find an alias by its friendly name (case-insensitive). */
export function findAliasByName(
  name: string,
  aliases: ProjectAlias[] = PROJECT_ALIASES,
): ProjectAlias | null {
  const n = name.trim().toLowerCase();
  return aliases.find((a) => a.name.toLowerCase() === n) ?? null;
}

/** Find an alias by its (absolute) path (case-insensitive). */
export function findAliasByPath(
  candidatePath: string,
  aliases: ProjectAlias[] = PROJECT_ALIASES,
): ProjectAlias | null {
  const p = path.resolve(candidatePath).toLowerCase();
  return aliases.find((a) => a.path.toLowerCase() === p) ?? null;
}

// ── Path helpers ───────────────────────────────────────────

function normalizePath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm.replace(/\/+$/, "") || "/";
}

function globToRegex(glob: string): RegExp {
  let re = glob.replace(/\\/g, "/").replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  // A matched path is a root itself → also allow its subtree (prefix semantics).
  return new RegExp(`^${re}(?:/.*)?$`, "i");
}

export interface Registration {
  /** Original entry after normalization (forward slashes). */
  entry: string;
  isGlob: boolean;
  regex?: RegExp;
}

/**
 * Convert a list of root entries (plain paths and/or globs) into registrations.
 * Exposed for tests; the runtime registry uses `ALLOWED_ROOTS`.
 */
export function buildRegistrations(roots: string[]): Registration[] {
  return roots.map((root) => {
    const entry = normalizePath(root);
    const isGlob = entry.includes("*") || entry.includes("?");
    return { entry, isGlob, regex: isGlob ? globToRegex(entry) : undefined };
  });
}

const REGISTRATIONS: Registration[] = buildRegistrations(ALLOWED_ROOTS);

function registrationMatches(reg: Registration, candidate: string): boolean {
  const c = normalizePath(candidate).toLowerCase();
  if (reg.isGlob) {
    return reg.regex ? reg.regex.test(c) : false;
  }
  const e = reg.entry.toLowerCase();
  return c === e || c.startsWith(e + "/");
}

/**
 * Find the most specific registration that matches `candidate`.
 * The matched registration defines the "lockbox" for write/read checks.
 */
export function findMatchingRegistration(
  candidate: string,
  registrations: Registration[] = REGISTRATIONS,
): Registration | null {
  const c = path.resolve(candidate);
  let best: Registration | null = null;
  for (const reg of registrations) {
    if (registrationMatches(reg, c)) {
      if (!best || reg.entry.length > best.entry.length) best = reg;
    }
  }
  return best;
}

export interface ResolvedContext {
  ok: true;
  cwd: string;
  registration: Registration;
}

export type ResolveResult = ResolvedContext | { ok: false; error: string };

/**
 * Resolve a requested working directory against the allowed registry.
 * - `cwd` omitted → primary root (first allowed root);
 * - relative `cwd` → resolved against `baseDir` (default: primary root);
 * - returns the resolved absolute dir + the matched registration,
 *   which is used to constrain write/read targets.
 */
export function resolveCwdRequested(
  cwd?: string,
  registrations: Registration[] = REGISTRATIONS,
  allowedRoots: string[] = ALLOWED_ROOTS,
  baseDir: string = PRIMARY_ROOT,
): ResolveResult {
  const requested = cwd && cwd.trim()
    ? path.resolve(baseDir, cwd.trim())
    : (allowedRoots[0] ? path.resolve(allowedRoots[0]) : path.resolve(baseDir));

  const registration = findMatchingRegistration(requested, registrations);
  if (!registration) {
    return {
      ok: false,
      error:
        `Adresár '${requested}' nie je v zozname povolených koreňov.\n` +
        `Povolené korene (MCP_PROJECT_ROOT / MCP_EXTRA_ROOTS):\n` +
        allowedRoots.map((r) => `  - ${r}`).join("\n") +
        `\nAk chceš spustiť príkaz v inom projekte, zadaj parameter "cwd" s povoleným koreňom.`,
    };
  }
  return { ok: true, cwd: requested, registration } as ResolvedContext;
}

// ── File path resolution (shared helper for file-based tools) ──

export type FilePathResult = { ok: true; filePath: string } | { ok: false; error: string };

/**
 * Resolve a file path (absolute or relative) against `cwd` or the primary root.
 * Validates the resolved path is inside an allowed root.
 *
 * - absolute path → validate against allowed roots, return as-is;
 * - relative path → resolve against `cwd` (or primary root), then validate;
 * - alias lookup: bare tokens without separators are checked against project aliases.
 */
export function resolveFilePath(
  filePath: string,
  cwd?: string,
  registrations: Registration[] = REGISTRATIONS,
  allowedRoots: string[] = ALLOWED_ROOTS,
  baseDir: string = PRIMARY_ROOT,
): FilePathResult {
  // Resolve the base directory for relative paths
  let basePath = baseDir;
  if (cwd && cwd.trim()) {
    let resolved = cwd.trim();
    // Alias lookup for bare tokens
    if (!resolved.includes("\\") && !resolved.includes("/")) {
      const alias = findAliasByName(resolved);
      if (alias) resolved = alias.path;
    }
    const cwdResult = resolveCwdRequested(resolved, registrations, allowedRoots, baseDir);
    if (!cwdResult.ok) return { ok: false, error: cwdResult.error };
    basePath = cwdResult.cwd;
  }

  let resolved: string;
  if (path.isAbsolute(filePath)) {
    resolved = path.resolve(filePath);
  } else {
    resolved = path.resolve(basePath, filePath);
  }

  // Validate against allowed roots
  const registration = findMatchingRegistration(resolved, registrations);
  if (!registration) {
    return {
      ok: false,
      error:
        `Súbor '${resolved}' nie je v žiadnom povolenom koreni.\n` +
        `Povolené korene (MCP_PROJECT_ROOT / MCP_EXTRA_ROOTS):\n` +
        allowedRoots.map((r) => `  - ${r}`).join("\n"),
    };
  }

  return { ok: true, filePath: resolved };
}

// ── Project discovery (read-only, used by list_allowed_roots / resolve_cwd) ─

/**
 * Largest prefix before a glob wildcard (or the whole entry for plain roots).
 * `D:\W\TS\*` → `D:\W\TS`; `D:\W` → `D:\W`.
 */
function registrationScanDir(reg: Registration): string {
  if (!reg.isGlob) return reg.entry;
  const idx = reg.entry.search(/[*?]/);
  const prefix = idx === -1 ? reg.entry : reg.entry.slice(0, idx);
  const lastSep = prefix.lastIndexOf("/");
  return lastSep <= 0 ? "/" : prefix.slice(0, lastSep);
}

/** Single-path scan helper with a safety cap. */
async function collectProjectsUnder(
  scanDir: string,
  reg: Registration,
  out: Set<string>,
): Promise<number> {
  let entries: import("fs").Dirent[];
  try {
    entries = await readdir(scanDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let capped = 0;
  for (const dirent of entries) {
    if (capped >= 200) {
      out.add(`${scanDir} (… a ďalšie, limit 200)`);
      break;
    }
    if (!dirent.isDirectory()) continue;
    const candidate = path.join(scanDir, dirent.name);
    if (registrationMatches(reg, candidate)) {
      out.add(path.resolve(candidate));
      capped++;
    }
  }
  return capped;
}

/**
 * Discover concrete existing project directories under the registered roots.
 * Read-only (fs.readdir), no shell execution. Used by `list_allowed_roots`
 * so the agent can see its own workspace in the list of allowed cwd values.
 *
 * NOTE: this is a heuristic listing of one level of subdirectories under each
 * root. It is NOT a guarantee that a project exists — a path is allowed if it
 * matches a registration regardless of whether it is listed here.
 */
export async function findAllowedProjects(
  registrations: Registration[] = REGISTRATIONS,
  allowedRoots: string[] = ALLOWED_ROOTS,
  aliases: ProjectAlias[] = PROJECT_ALIASES,
): Promise<Array<string | { path: string; name: string }>> {
  const out = new Map<string, Set<string>>();
  for (const reg of registrations) {
    if (!out.has(reg.entry)) out.set(reg.entry, new Set());
    const scanDir = registrationScanDir(reg);
    await collectProjectsUnder(
      scanDir.startsWith("/") && !allowedRoots.some((r) => path.resolve(r).startsWith("/")) ? "\u0000" : scanDir,
      reg,
      out.get(reg.entry)!,
    );
  }

  // Deduplicate across registrations, keep insertion order.
  const seen = new Set<string>();
  const result: Array<string | { path: string; name: string }> = [];
  for (const set of out.values()) {
    for (const p of set) {
      const key = path.resolve(p).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const alias = findAliasByPath(p, aliases);
        result.push(alias ? { path: path.resolve(p), name: alias.name } : path.resolve(p));
      }
    }
  }

  // Aliased projects are guaranteed to appear even when they are nested deeper
  // than the one-level scan (e.g. shortened folder names for build-tool path
  // limits, or deeply nested projects) — as long as they match a registration.
  for (const alias of aliases) {
    if (findMatchingRegistration(alias.path, registrations)) {
      const key = path.resolve(alias.path).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ path: path.resolve(alias.path), name: alias.name });
      }
    }
  }

  return result;
}

// ── Dangerous pattern detection ────────────────────────────

interface DangerousPattern {
  pattern: RegExp;
  label: string;
}

/**
 * List of patterns that indicate a dangerous / destructive command.
 * Each pattern is tested case-insensitively against the full command string.
 *
 * NOTE: This is a best-effort blacklist and NOT a security guarantee.
 * Shell features (variables, eval, encoding tricks) can bypass it.
 * For production isolation use Docker / VM sandboxing.
 *
 * IMPORTANT: `\b` does not reliably match right after non-word characters
 * (`/`, `.`, `~`, `*`, ...) when followed by whitespace or end-of-string,
 * since both sides end up non-word. Use `(?=\s|$|...)` lookaheads instead
 * of `\b` in those positions.
 */
export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // File system destruction — flags in either order (-rf, -fr, -Rf, -vfr, ...)
  {
    pattern: /\brm\s+-([a-z]*r[a-z]*f[a-z]*|[a-z]*f[a-z]*r[a-z]*)\b/i,
    label: "rekurzívne a vynútené mazanie (rm s flagmi r+f v ľubovoľnom poradí)",
  },
  { pattern: /\brmdir\s+\/s\s+\/q\b/i, label: "tiché rekurzívne mazanie priečinka (Windows rmdir /s /q)" },
  { pattern: /\bdel\s+\/f\s+\/s\b/i, label: "vynútené rekurzívne mazanie súborov (Windows del /f /s)" },
  { pattern: /\bformat\s+\w:\s*\/q\s*\/y\b/i, label: "formátovanie disku" },
  { pattern: /\bmkfs\b/i, label: "vytvorenie nového súborového systému (mkfs)" },
  { pattern: /\bdd\s+if=/i, label: "priamy zápis na blokové zariadenie (dd)" },
  { pattern: /\bfdisk\b/i, label: "úprava diskových oddielov (fdisk)" },
  { pattern: /\bdiskpart\b/i, label: "úprava diskových oddielov (diskpart)" },

  // Overwriting raw devices
  { pattern: /\b>\s*\/dev\/(sd|hd|nvme|xvd)[a-z0-9]*\b/i, label: "priamy zápis na diskové zariadenie (/dev/sd*, /dev/hd*, ...)" },

  // Git destructive operations
  {
    // `--force` also covers `--force-with-lease` (its prefix, `\b` at `·`).
    pattern: /\bgit\s+push\s+.*?--force\b/i,
    label: "vynútený git push (--force / --force-with-lease)",
  },
  {
    // `-f` (short flag) must be its own token. `(?:[^\s-]*\s+)*` skips any
    // refs/args before it, but stops before a `-` so `feature-f` is not a
    // false positive. The trailing `(?:\s|$)` requires the token boundary.
    pattern: /\bgit\s+push\s+(?:[^\s-]*\s+)*-f(?:\s|$)/i,
    label: "vynútený git push (flag -f)",
  },
  { pattern: /\bgit\s+reset\s+--hard\b/i, label: "tvrdý git reset (stratí necommitnuté zmeny)" },
  {
    pattern: /\bgit\s+clean\s+-([a-z]*f[a-z]*d[a-z]*|[a-z]*d[a-z]*f[a-z]*)\b/i,
    label: "vynútené zmazanie needitovaných súborov (git clean s flagmi f+d v ľubovoľnom poradí)",
  },

  // Database drop
  { pattern: /\bdrop\s+database\b/i, label: "zmazanie databázy (DROP DATABASE)" },
  { pattern: /\bdrop\s+table\b/i, label: "zmazanie tabuľky (DROP TABLE)" },
  { pattern: /\btruncate\s+table\b/i, label: "vyprázdnenie tabuľky (TRUNCATE TABLE)" },

  // System modification
  { pattern: /\bshutdown\b/i, label: "vypnutie systému" },
  { pattern: /\breboot\b/i, label: "reštart systému" },
  { pattern: /\bpoweroff\b/i, label: "vypnutie systému (poweroff)" },
  { pattern: /\bhibernate\b/i, label: "hibernácia systému" },
  { pattern: /\binit\s+[06]\b/i, label: "zmena runlevelu (init 0/6 — vypnutie/reštart)" },

  // Fork bombs / denial of service
  { pattern: /:\(\)\s*\{[^}]*\}\s*;?\s*:/i, label: "fork bomba (bash)" },
  { pattern: /\bwhile\s+true\s*;?\s*do[\s\S]*?\bdone\b/i, label: "nekonečná slučka (while true; do ... done)" },

  // Permission changes on root filesystem
  { pattern: /\bchmod\s+-R\s+777\s+\/(\s|$)/i, label: "rekurzívna zmena práv na koreňovom súborovom systéme (chmod -R 777 /)" },
  { pattern: /\bchown\s+-R\b.*\s+\/(\s|$)/i, label: "rekurzívna zmena vlastníka na koreňovom súborovom systéme (chown -R /)" },

  // Package manager destructive actions
  { pattern: /\bnpm\s+(uninstall|remove|rm)\s+/i, label: "odinštalovanie npm balíčka" },
  { pattern: /\bnpm\s+cache\s+clean\s*--force\b/i, label: "vynútené vyčistenie npm cache" },

  // Piping remote scripts directly into a shell (common malware vector)
  { pattern: /\b(curl|wget)\s+.*\|\s*(bash|sh|zsh|powershell)\b/i, label: "spustenie stiahnutého skriptu priamo v shelli (curl|bash)" },
];

/**
 * Check if a command matches any dangerous pattern.
 * Returns the matched label if dangerous, or null if safe.
 */
export function isDangerous(command: string): string | null {
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return label;
    }
  }
  return null;
}

// ── Directory-escape detection ─────────────────────────────

interface EscapePattern {
  pattern: RegExp;
  label: string;
}

/**
 * Patterns that indicate the command tries to change directory / operate
 * outside the allowed project root. Checked anywhere in the command
 * (works for both standalone and chained commands like `a && cd .. && b`).
 *
 * Uses lookaheads `(?=...)` instead of trailing `\b`, since `\b` does not
 * reliably match right after non-word characters like `.` or `~`.
 *
 * Windows `cd /d ...` is always blocked: switching projects/drives must be
 * done via the `cwd` parameter, never via a `cd` jump in the command.
 */
const ESCAPE_PATTERNS: EscapePattern[] = [
  { pattern: /\bcd\s+\.\.(?=[\s/\\]|$)/i, label: "cd .." },
  { pattern: /\bpushd\s+\.\.(?=[\s/\\]|$)/i, label: "pushd .." },
  { pattern: /\bcd\s+~(?=[\s/\\]|$)/i, label: "cd ~" },
  { pattern: /\bcd\s+[A-Za-z]:\\/i, label: "cd C:\\... (absolútna Windows cesta)" },
  { pattern: /\bpushd\s+[A-Za-z]:\\/i, label: "pushd C:\\... (absolútna Windows cesta)" },
  { pattern: /\bcd\s+\//i, label: "cd /absolútna cesta" },
  { pattern: /\bpushd\s+\//i, label: "pushd /absolútna cesta" },
  { pattern: /\bcd\s+\/d\b/i, label: "cd /d (Windows prepnutie priečinka/jednotky)" },
];

/**
 * Check if a command tries to escape the allowed root directory.
 * Returns the label of the matched pattern, or null if safe.
 */
export function findEscapeReason(command: string): string | null {
  const trimmed = command.trim();
  for (const { pattern, label } of ESCAPE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return label;
    }
  }
  return null;
}

/**
 * Check if a command appears safe to run inside the allowed root directory.
 */
export function isWithinAllowedDir(command: string): boolean {
  return findEscapeReason(command) === null;
}

// ── Write-target detection (best-effort) ───────────────────

function isFlag(tok: string): boolean {
  return tok.startsWith("-") || /^\/[a-z]/i.test(tok);
}

function lastNonFlag(tokens: string[]): string | undefined {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!isFlag(tokens[i])) return tokens[i];
  }
  return undefined;
}

function tokenizeCommand(command: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(?:^|\s)([^\s"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const token = m[1] !== undefined ? m[1] : m[2];
    if (token) out.push(token);
  }
  return out;
}

/**
 * Extract the target file(s) of shell output redirects (`>`, `>>`, `2>`, ...).
 * Best-effort heuristic — not a security guarantee. Shared by the write-target
 * safety check and the redirect reporting in `src/redirect.ts`.
 */
export function extractRedirectTargets(command: string): string[] {
  const out: string[] = [];
  // Match redirects even without a space before `>` (e.g. `echo hi>out.log`).
  // `[^\s|&>]*` consumes the command/argument text preceding the marker.
  // `(?!&\d|&-)` skips fd-duplication / fd-close targets (`2>&1`, `>&2`,
  // `>&-`) — these are not files and would surface as bogus targets like `&1`.
  const re = /(^|[\s|&])[^\s|&>]*\d*>>?\s*(?!&\d|&-)(?:"([^"]*)"|([^\s|;]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const target = m[2] !== undefined ? m[2] : m[3];
    if (target) out.push(target);
  }
  return out;
}

/**
 * Extract the target of destructive commands where the target MUST exist for
 * the command to succeed — `rmdir` (incl. `rmdir /s /q`), `del`/`erase` and
 * PowerShell `Remove-Item`. `rm -rf` and `git clean` are deliberately
 * excluded: they are idempotent and succeed even when the target is missing.
 *
 * Used to give a helpful "wrong cwd" message instead of a raw
 * `The system cannot find the file specified` when a confirmed destructive
 * command targets a path that does not exist in the active project.
 */
export function extractDestructiveTargets(command: string): string[] {
  const out: string[] = [];
  const tokens = tokenizeCommand(command);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase();
    if (t === "rmdir" || t === "del" || t === "erase" || t === "remove-item") {
      // Skip flags (rmdir /s /q, del /f /s, Remove-Item -Recurse -Force, ...)
      // and take the first non-flag token as the target.
      const target = tokens.slice(i + 1).find((tok) => !isFlag(tok));
      if (target) out.push(target);
    }
  }
  return out;
}

function extractCommandWriteTargets(command: string): { target: string; reason: string }[] {
  const results: { target: string; reason: string }[] = [];
  const tokens = tokenizeCommand(command);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();

    if ((t === "mkdir" || t === "md") && i + 1 < tokens.length) {
      // Skip option flags (e.g. `mkdir -p D:\projB\x`) and take the first
      // non-flag token as the target directory.
      const dst = tokens.slice(i + 1).find((tok) => !isFlag(tok));
      if (dst) results.push({ target: dst, reason: t });
      i++;
      continue;
    }

    if ((t === "copy" || t === "move") && i + 1 < tokens.length) {
      const dst = lastNonFlag(tokens.slice(i + 1));
      if (dst) results.push({ target: dst, reason: t });
      continue;
    }

    if (t === "xcopy" && i + 1 < tokens.length) {
      const dst = lastNonFlag(tokens.slice(i + 1));
      if (dst) results.push({ target: dst, reason: "xcopy" });
      continue;
    }

    if (t === "tee") {
      for (const f of tokens.slice(i + 1)) {
        if (!isFlag(f)) results.push({ target: f, reason: "tee" });
      }
      continue;
    }

    if ((t === "curl" || t === "wget") && i + 1 < tokens.length) {
      const flagNames = t === "curl"
        ? new Set(["-o", "--output"])
        : new Set(["-o", "-O", "--output-document", "--log-file"]);
      for (let j = i + 1; j < tokens.length - 1; j++) {
        if (flagNames.has(tokens[j])) {
          results.push({ target: tokens[j + 1], reason: `${t} ${tokens[j]}` });
        }
      }
      continue;
    }

    if (t === "git") {
      // git -C / --git-dir / --work-tree redirects the whole operation to another dir
      // (which can be a write, e.g. commit/push) — treat as cross-root operator.
      for (let j = i + 1; j < tokens.length - 1; j++) {
        if (tokens[j] === "-C" || tokens[j] === "--git-dir" || tokens[j] === "--work-tree") {
          results.push({ target: tokens[j + 1], reason: `git ${tokens[j]} (prepnutie adresára)` });
        }
      }
      continue;
    }
  }

  return results;
}

function resolveTarget(raw: string, cwd: string): string {
  let t = raw.trim();
  t = t.replace(/^["']|["']$/g, "");
  if (t.includes("*") || t.includes("?")) {
    // Wildcard — check the directory prefix before the first wildcard.
    const idx = t.search(/[*?]/);
    t = t.slice(0, idx);
    if (!t) return normalizePath(cwd);
  }
  return normalizePath(path.isAbsolute(t) ? path.resolve(t) : path.resolve(cwd, t));
}

/**
 * Find target paths that the command writes to which are outside the
 * active project root. Best-effort heuristic — not a security guarantee.
 */
export function findOutOfRootWriteTargets(
  command: string,
  cwd: string,
  registration: Registration,
): { target: string; reason: string }[] {
  const found: { target: string; reason: string }[] = [];
  const seen = new Set<string>();

  const consider = (raw: string, reason: string) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (trimmed.toUpperCase() === "NUL" || trimmed === "/dev/null") return;
    const resolved = resolveTarget(trimmed, cwd);
    if (!registrationMatches(registration, resolved)) {
      const key = resolved.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ target: resolved, reason });
      }
    }
  };

  for (const raw of extractRedirectTargets(command)) {
    consider(raw, "presmerovanie výstupu (>)");
  }
  for (const { target, reason } of extractCommandWriteTargets(command)) {
    consider(target, reason);
  }

  return found;
}

// ── Cross-root read detection (opt-in, best-effort) ────────

const READ_TOOLS = /\b(cat|type|more|less|findstr|Get-Content|Select-String|grep|egrep|head|tail|strings|wc|diff|fc)\b/i;
const QUOTED_PATH = /["']((?:[A-Za-z]:[\\/]|\.\.[\\/]|~[\\/])\S*?)["']/g;

/**
 * Find obvious reads outside the active project root.
 * Only used when `MCP_BLOCK_CROSS_ROOT_READS=1`. Best-effort heuristic —
 * not a security guarantee (obfuscatable via variables, eval, encodings...).
 */
export function findSuspiciousCrossRootReads(
  command: string,
  cwd: string,
  registration: Registration,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const considerQuotedPaths = () => {
    QUOTED_PATH.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = QUOTED_PATH.exec(command)) !== null) {
      const resolved = resolveTarget(m[1], cwd);
      if (!registrationMatches(registration, resolved)) {
        const key = resolved.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          found.push(resolved);
        }
      }
    }
  };

  if (READ_TOOLS.test(command) || /\bgit\s+(-C|--git-dir|--work-tree)\b/i.test(command)) {
    considerQuotedPaths();
    const tokens = tokenizeCommand(command);
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i] === "-C" || tokens[i] === "--git-dir" || tokens[i] === "--work-tree") {
        const resolved = resolveTarget(tokens[i + 1], cwd);
        if (!registrationMatches(registration, resolved)) {
          const key = resolved.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            found.push(resolved);
          }
        }
      }
    }
  }

  if (/\b(node|deno|bun|python|python3|ruby)\s+/i.test(command)) {
    if (/(readFileSync|readFile|readdirSync|readdir|openFile|read_text|open\(|Path\(|glob\()/i.test(command)) {
      considerQuotedPaths();
    }
  }

  return found;
}