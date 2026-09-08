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
// src/batch.ts — apply multiple file edits atomically with rollback on failure.
import fs from "fs";

export interface EditObject {
  file: string;
  search: string;
  replace: string;
  description?: string;
  replaceAll?: boolean;
}

export interface BatchOptions { dryRun?: boolean; }

export interface PreviewEntry {
  file: string;
  action: "edit" | "error";
  description?: string;
  matchCount: number;
  error?: string;
}

export interface BatchResult {
  dryRun: boolean;
  totalEdits: number;
  validated: number;
  preview: PreviewEntry[];
}

export interface BatchError {
  error: string;
  failedAt: number;
  preview: PreviewEntry[];
}

/**
 * Normalize line endings to LF for comparison, preserving original style for write-back.
 */
function normalizeLineEndings(text: string): { normalized: string; eol: string } {
  if (text.includes("\r\n")) return { normalized: text.replace(/\r\n/g, "\n"), eol: "\r\n" };
  return { normalized: text, eol: "\n" };
}

function restoreLineEndings(text: string, eol: string): string {
  if (eol === "\r\n") return text.replace(/\n/g, "\r\n");
  return text;
}

/**
 * Validate all edits first. If any fail, return error — NO files modified.
 * On success in non-dryRun mode, apply with rollback on failure.
 */
export function batchApplyEdits(edits: EditObject[], options: BatchOptions = {}): BatchResult | BatchError {
  const { dryRun = true } = options;
  const preview: PreviewEntry[] = [];

  // Phase 1: Validate
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    let content: string;
    try { content = fs.readFileSync(edit.file, "utf-8"); } catch {
      preview.push({ file: edit.file, action: "error", matchCount: 0, error: `Cannot read file: ${edit.file}`, description: edit.description });
      return { error: `Cannot read file: ${edit.file}`, failedAt: i, preview };
    }
    const { normalized } = normalizeLineEndings(content);
    const count = countOccurrences(normalized, edit.search);
    if (count === 0) {
      preview.push({ file: edit.file, action: "error", matchCount: 0, error: `search string not found in ${edit.file}`, description: edit.description });
      return { error: `search string not found in ${edit.file}`, failedAt: i, preview };
    }
    if (count > 1 && !edit.replaceAll) {
      preview.push({ file: edit.file, action: "error", matchCount: count, error: `search string found ${count} times in ${edit.file} (replaceAll: false)`, description: edit.description });
      return { error: `search string found ${count} times in ${edit.file} (replaceAll: false)`, failedAt: i, preview };
    }
    preview.push({ file: edit.file, action: "edit", matchCount: count, description: edit.description });
  }

  if (dryRun) return { dryRun: true, totalEdits: edits.length, validated: edits.length, preview };

  // Phase 2: Apply with rollback — accumulate changes per file
  const fileStates = new Map<string, { original: string; current: string; eol: string }>();
  try {
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      if (!fileStates.has(edit.file)) {
        const raw = fs.readFileSync(edit.file, "utf-8");
        const { normalized, eol } = normalizeLineEndings(raw);
        fileStates.set(edit.file, { original: raw, current: normalized, eol });
      }
      const state = fileStates.get(edit.file)!;
      const newContent = edit.replaceAll
        ? state.current.split(edit.search).join(edit.replace)
        : state.current.replace(edit.search, edit.replace);
      state.current = newContent; // accumulate for next edit on same file
      fs.writeFileSync(edit.file, restoreLineEndings(newContent, state.eol), "utf-8");
    }
  } catch (err) {
    // Rollback
    for (const [file, state] of fileStates) {
      try { fs.writeFileSync(file, state.original, "utf-8"); } catch { /* best effort */ }
    }
    return { error: `Write failed: ${err}`, failedAt: -1, preview };
  }

  return { dryRun: false, totalEdits: edits.length, validated: edits.length, preview };
}

function countOccurrences(text: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(search, idx)) !== -1) { count++; idx += search.length; }
  return count;
}
