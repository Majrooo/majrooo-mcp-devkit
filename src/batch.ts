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
// src/batch.ts — apply multiple file edits with partial rollback on failure.
import fs from "fs";

export interface EditObject {
  file: string;
  search: string;
  replace: string;
  description?: string;
  replaceAll?: boolean;
  excludePatterns?: string[];
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

  // Phase 1: Validate (quick check against original file content).
  // For chained edits on the same file, skip "search not found" errors —
  // the search string may be created by a previous edit in the batch.
  // Phase 2 will re-validate with proper sequential state.
  const filesSeen = new Set<string>();
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    let content: string;
    try { content = fs.readFileSync(edit.file, "utf-8"); } catch {
      preview.push({ file: edit.file, action: "error", matchCount: 0, error: `Cannot read file: ${edit.file}`, description: edit.description });
      return { error: `Cannot read file: ${edit.file}`, failedAt: i, preview };
    }
    const { normalized } = normalizeLineEndings(content);
    const excludeRanges = edit.excludePatterns && edit.excludePatterns.length > 0
      ? findExcludeRanges(normalized, edit.excludePatterns) : [];
    const count = excludeRanges.length > 0 && edit.replaceAll
      ? countReplacableOccurrences(normalized, edit.search, excludeRanges)
      : countOccurrences(normalized, edit.search);
    if (count === 0) {
      // If there was a previous edit on the same file, the search string may
      // be created by that edit. Skip validation — Phase 2 will re-check.
      if (filesSeen.has(edit.file)) {
        preview.push({ file: edit.file, action: "edit", matchCount: 0, description: `${edit.description ?? "edit"} (deferred — depends on previous edit)` });
        continue;
      }
      preview.push({ file: edit.file, action: "error", matchCount: 0, error: `search string not found in ${edit.file}`, description: edit.description });
      return { error: `search string not found in ${edit.file}`, failedAt: i, preview };
    }
    if (count > 1 && !edit.replaceAll) {
      preview.push({ file: edit.file, action: "error", matchCount: count, error: `search string found ${count} times in ${edit.file} (replaceAll: false)`, description: edit.description });
      return { error: `search string found ${count} times in ${edit.file} (replaceAll: false)`, failedAt: i, preview };
    }
    preview.push({ file: edit.file, action: "edit", matchCount: count, description: edit.description });
    filesSeen.add(edit.file);
  }

  if (dryRun) return { dryRun: true, totalEdits: edits.length, validated: edits.length, preview };

  // Phase 2: Apply sequentially with per-edit validation and partial rollback.
  // Each edit is validated against the CURRENT file state (after previous edits),
  // so chained edits on the same file work correctly.
  // On failure: rollback only files modified by the failed edit and later edits,
  // preserving successfully completed edits on other files.
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
      // Re-validate against current state (after previous edits on this file)
      const excludeRanges = edit.excludePatterns && edit.excludePatterns.length > 0
        ? findExcludeRanges(state.current, edit.excludePatterns) : [];
      const count = excludeRanges.length > 0 && edit.replaceAll
        ? countReplacableOccurrences(state.current, edit.search, excludeRanges)
        : countOccurrences(state.current, edit.search);
      if (count === 0) {
        // Partial rollback: only revert files modified by this edit and later edits.
        // Files successfully modified by earlier edits are preserved.
        const filesToRevert = new Set<string>();
        filesToRevert.add(edit.file);
        for (let j = i + 1; j < edits.length; j++) {
          if (edits[j]!.file !== edit.file) filesToRevert.add(edits[j]!.file);
        }
        for (const [file, st] of fileStates) {
          if (filesToRevert.has(file)) {
            try { fs.writeFileSync(file, st.original, "utf-8"); } catch { /* best effort */ }
          }
        }
        return { error: `search string not found in ${edit.file} (after previous edits)`, failedAt: i, preview };
      }
      if (count > 1 && !edit.replaceAll) {
        const filesToRevert = new Set<string>();
        filesToRevert.add(edit.file);
        for (let j = i + 1; j < edits.length; j++) {
          if (edits[j]!.file !== edit.file) filesToRevert.add(edits[j]!.file);
        }
        for (const [file, st] of fileStates) {
          if (filesToRevert.has(file)) {
            try { fs.writeFileSync(file, st.original, "utf-8"); } catch { /* best effort */ }
          }
        }
        return { error: `search string found ${count} times in ${edit.file} (replaceAll: false)`, failedAt: i, preview };
      }
      const newContent = excludeRanges.length > 0 && edit.replaceAll
        ? replaceAllExcluding(state.current, edit.search, edit.replace, excludeRanges)
        : edit.replaceAll
          ? state.current.split(edit.search).join(edit.replace)
          : state.current.replace(edit.search, edit.replace);
      state.current = newContent; // accumulate for next edit on same file
      fs.writeFileSync(edit.file, restoreLineEndings(newContent, state.eol), "utf-8");
    }
  } catch (err) {
    // Rollback only files that were modified
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

/** Count occurrences of search string outside excluded ranges. */
function countReplacableOccurrences(text: string, search: string, excludeRanges: { start: number; end: number }[]): number {
  if (search.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(search, idx)) !== -1) {
    const inExcluded = excludeRanges.some((r) => idx >= r.start && idx < r.end);
    if (!inExcluded) count++;
    idx += search.length;
  }
  return count;
}

/**
 * Find ranges to exclude from replacement. Handles:
 * - #[cfg(test)] ... } blocks (Rust)
 * - #[cfg(not(test))] ... } blocks
 * - #[test] ... } blocks (annotated test functions)
 * - // test / // --- test --- comment markers until end of file
 *
 * The pattern string is matched against lines. If a line contains the pattern,
 * the entire block (from that line to the matching closing brace, if present)
 * is excluded.
 */
function findExcludeRanges(content: string, patterns: string[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const pat of patterns) {
    const lines = content.split("\n");
    let charIdx = 0;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]!;
      if (line.includes(pat)) {
        // Check if this line has an opening brace
        const braceIdx = line.indexOf("{");
        if (braceIdx >= 0) {
          // Find matching closing brace from this position
          let depth = 0;
          let endCharIdx = charIdx + line.length;
          const rest = content.slice(charIdx);
          for (let i = braceIdx; i < rest.length; i++) {
            if (rest[i] === "{") depth++;
            if (rest[i] === "}") depth--;
            if (depth === 0) { endCharIdx = charIdx + i + 1; break; }
          }
          ranges.push({ start: charIdx, end: endCharIdx });
        } else {
          // No brace on this line — look ahead up to 5 lines for the opening {
          let foundBrace = false;
          let lookaheadCharIdx = charIdx + line.length + 1; // +1 for \n
          for (let ahead = 1; ahead <= 5 && lineIdx + ahead < lines.length; ahead++) {
            const nextLine = lines[lineIdx + ahead]!;
            const nextBraceIdx = nextLine.indexOf("{");
            if (nextBraceIdx >= 0) {
              // Found opening brace — find matching closing brace
              let depth = 0;
              let endCharIdx = lookaheadCharIdx + nextLine.length;
              const rest = content.slice(lookaheadCharIdx);
              for (let i = nextBraceIdx; i < rest.length; i++) {
                if (rest[i] === "{") depth++;
                if (rest[i] === "}") depth--;
                if (depth === 0) { endCharIdx = lookaheadCharIdx + i + 1; break; }
              }
              ranges.push({ start: charIdx, end: endCharIdx });
              foundBrace = true;
              break;
            }
            lookaheadCharIdx += nextLine.length + 1;
          }
          if (!foundBrace) {
            // No brace found nearby — exclude single line
            ranges.push({ start: charIdx, end: charIdx + line.length });
          }
        }
      }
      charIdx += line.length + 1; // +1 for \n
    }
  }
  // Sort by start, merge overlapping
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges) {
    if (merged.length > 0 && r.start <= merged[merged.length - 1]!.end) {
      merged[merged.length - 1]!.end = Math.max(merged[merged.length - 1]!.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Replace all occurrences outside excluded ranges.
 */
function replaceAllExcluding(content: string, search: string, replace: string, excludeRanges: { start: number; end: number }[]): string {
  if (excludeRanges.length === 0) return content.split(search).join(replace);
  let result = "";
  let lastIdx = 0;
  let idx = 0;
  while ((idx = content.indexOf(search, idx)) !== -1) {
    // Check if this occurrence is inside an excluded range
    const inExcluded = excludeRanges.some((r) => idx >= r.start && idx < r.end);
    if (!inExcluded) {
      result += content.slice(lastIdx, idx) + replace;
      lastIdx = idx + search.length;
    }
    idx += search.length;
  }
  result += content.slice(lastIdx);
  return result;
}
