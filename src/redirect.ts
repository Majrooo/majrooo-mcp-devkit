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
// src/redirect.ts — reporting of command output that was redirected into files.
//
// When a command ends with `> file.log` / `>> file.log` / `2> file.log`, the
// output never reaches the MCP response. These helpers detect the redirect
// targets and read back the written file (at least its tail), so the response
// says *where* the output went and shows its content instead of being empty
// or showing only a bare `Command failed: ...` message.
import path from "path";
import { open, readFile, stat } from "fs/promises";
import { stripAnsi } from "./output.js";

/** Whole files up to this size are read fully; bigger ones only from the tail. */
const REDIRECT_READ_LIMIT_BYTES = 2 * 1024 * 1024;

/** Size of the tail chunk read from the end of a very large redirect file. */
const REDIRECT_TAIL_CHUNK_BYTES = 64 * 1024;

export interface RedirectFileInfo {
  read: boolean;
  /** Number of lines for small files, `null` when only a tail chunk was read. */
  totalLines: number | null;
  /** Up to `maxLines` lines from the end of the file. */
  tail: string[];
  truncated: boolean;
}

/**
 * Keep only redirect targets that are actually readable files.
 * Drops `NUL`/`/dev/null` (discard targets), wildcard patterns and
 * fd-duplication / fd-close tokens (`&1`, `&2`, `&-`) that the redirect
 * parser may surface from `2>&1` / `>&2` / `>&-`.
 */
export function filterRedirectTargets(targets: string[]): string[] {
  return targets.filter((t) => {
    const trimmed = t.trim();
    if (!trimmed) return false;
    const upper = trimmed.toUpperCase();
    if (upper === "NUL" || trimmed === "/dev/null") return false;
    if (trimmed.includes("*") || trimmed.includes("?")) return false;
    if (/^&-?\d*$/.test(trimmed)) return false;
    return true;
  });
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Slovak pluralization of line counts: 1 riadok, 2–4 riadky, 5+ riadkov. */
export function pluralLines(n: number): string {
  if (n === 1) return "1 riadok";
  if (n >= 2 && n <= 4) return `${n} riadky`;
  return `${n} riadkov`;
}

/**
 * Read the (tail of the) redirect file.
 * Returns `null` when the file does not exist or cannot be read.
 */
export async function readRedirectFile(filePath: string, maxLines: number): Promise<RedirectFileInfo | null> {
  const safeMax = Math.max(1, maxLines);
  try {
    const { size } = await stat(filePath);
    if (size > REDIRECT_READ_LIMIT_BYTES) {
      // Very large file — read only a chunk from the end and keep its tail.
      const handle = await open(filePath, "r");
      try {
        const chunkSize = Math.min(size, REDIRECT_TAIL_CHUNK_BYTES);
        const buf = Buffer.alloc(chunkSize);
        const { bytesRead } = await handle.read(buf, 0, chunkSize, size - chunkSize);
        const content = stripAnsi(buf.subarray(0, bytesRead).toString("utf-8"));
        const lines = splitLines(content);
        return {
          read: true,
          totalLines: null,
          tail: lines.slice(-safeMax),
          truncated: true,
        };
      } finally {
        await handle.close();
      }
    }

    const content = stripAnsi(await readFile(filePath, "utf-8"));
    const lines = splitLines(content);
    return {
      read: true,
      totalLines: lines.length,
      tail: lines.slice(-safeMax),
      truncated: lines.length > safeMax,
    };
  } catch {
    return null;
  }
}

/**
 * Build the human-readable note appended to a run_safe_command / 
 * run_destructive_command response when the command redirected its output
 * into one or more files.
 *
 * Returns `null` when there are no (readable) redirect targets.
 */
export async function buildRedirectNote(
  targets: string[],
  cwd: string,
  maxLines: number,
): Promise<string | null> {
  const clean = filterRedirectTargets(targets);
  if (clean.length === 0) return null;

  const parts: string[] = [];
  for (const raw of clean) {
    const filePath = path.resolve(cwd, raw);
    parts.push(`[Výstup presmerovaný do: ${filePath}]`);

    const info = await readRedirectFile(filePath, maxLines);
    if (!info) {
      parts.push(`[Súbor ${filePath} sa nepodarilo prečítať (zatiaľ neexistuje alebo je nečitateľný)]`);
      continue;
    }

    const shown = info.tail;
    if (info.truncated) {
      parts.push(
        info.totalLines !== null
          ? `[Posledných ${pluralLines(shown.length)} z ${info.totalLines} celkovo]`
          : `[Posledných ${pluralLines(shown.length)} — súbor je veľký, načítaný len z konca]`,
      );
    } else {
      parts.push(`[Obsah súboru (${pluralLines(info.totalLines ?? shown.length)}):]`);
    }
    parts.push(shown.join("\n"));
  }

  return parts.join("\n");
}