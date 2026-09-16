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
// src/feedback.ts — structured feedback log for MCP tool issues.
import fs from "fs";
import path from "path";

const HEADER_MARKER = "<!-- project=";
const FEEDBACK_DIR = ".mcp";
const FEEDBACK_FILE = "FEEDBACK.md";
const ARCHIVE_FILE = "FEEDBACK_ARCHIVE.md";
const ARCHIVE_TITLE = "# MCP Tool Feedback Archive";
const SEPARATOR = "\n---\n";

export interface FeedbackEntry {
  id: string;
  date: string; // ISO timestamp (YYYY-MM-DDTHH:MM:SSZ)
  tool: string;
  type: "bug" | "improvement" | "feature_request";
  status: "open" | "closed";
  title: string;
  description: string;
  reproduction?: string;
  expected?: string;
  suggestion?: string;
  resolution?: string;
  closedAt?: string;
}

export interface FeedbackResult { written: boolean; id: string; filePath: string; reason?: string; }
export interface FeedbackError { error: string; }
export interface CloseResult {
  updated: boolean;
  id: string;
  filePath: string;
  /** IDs moved from FEEDBACK.md to FEEDBACK_ARCHIVE.md by this call (self-healing). */
  archived: string[];
  archivePath: string;
}
export interface ArchiveResult {
  /** Number of entries moved to the archive in this call. */
  archived: number;
  /** IDs of the entries moved in this call. */
  ids: string[];
  /** The archive file (.mcp/FEEDBACK_ARCHIVE.md). */
  filePath: string;
  /** The active log the entries were moved out of (.mcp/FEEDBACK.md). */
  sourcePath: string;
}

function buildHeader(project: string, server: string, version: string): string {
  return `<!-- project=${project} server=${server} v${version} -->`;
}

function hasValidHeader(content: string, project: string): boolean {
  return content.split(/\r?\n/).slice(0, 5).join("\n").includes(`${HEADER_MARKER}${project}`);
}

function generateId(tool: string, title: string): string {
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${date}-${tool}-${slug}`;
}

function isDuplicate(content: string, id: string): boolean {
  return content.includes(`> **id:** ${id}`);
}

/** Remove a trailing "---" separator (plus surrounding blank lines) left by a previous write. */
function stripTrailingSeparator(content: string): string {
  return content.trimEnd().replace(/(^|\n)---$/, "").trimEnd();
}

function formatEntry(entry: FeedbackEntry): string {
  const lines: string[] = [];
  lines.push(`## [${entry.type.toUpperCase().replace("_", " ")}] ${entry.title}`);
  lines.push(`> **id:** ${entry.id}`);
  const displayDate = entry.date.length > 10 ? entry.date.replace("T", " ").replace(/Z$/, " UTC") : entry.date;
  lines.push(`> **date:** ${displayDate}`);
  lines.push(`> **tool:** ${entry.tool}`);
  lines.push(`> **type:** ${entry.type}`);
  lines.push(`> **status:** ${entry.status}`);
  lines.push("");
  lines.push(entry.description);
  if (entry.reproduction) lines.push("", `**Reproduction:** ${entry.reproduction}`);
  if (entry.expected) lines.push(`**Expected:** ${entry.expected}`);
  if (entry.suggestion) lines.push(`**Suggestion:** ${entry.suggestion}`);
  if (entry.resolution) lines.push(`**Resolution:** ${entry.resolution}`);
  return lines.join("\n");
}

/**
 * Report a tool feedback entry. Creates .mcp/FEEDBACK.md if needed,
 * validates header, appends entry. Idempotent — duplicate IDs skipped.
 */
export function reportToolFeedback(
  projectRoot: string,
  project: string,
  serverName: string,
  serverVersion: string,
  input: {
    type: "bug" | "improvement" | "feature_request";
    tool: string;
    title: string;
    description: string;
    reproduction?: string;
    expected?: string;
    suggestion?: string;
  },
): FeedbackResult | FeedbackError {
  const dir = path.join(projectRoot, FEEDBACK_DIR);
  const filePath = path.join(dir, FEEDBACK_FILE);

  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {
    return { error: `Cannot create directory: ${dir}` };
  }

  const id = generateId(input.tool, input.title);
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const entry: FeedbackEntry = {
    id, date, tool: input.tool, type: input.type, status: "open",
    title: input.title, description: input.description,
    reproduction: input.reproduction, expected: input.expected, suggestion: input.suggestion,
  };

  let content = "";
  let isNew = false;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { isNew = true; }

  if (!isNew && !hasValidHeader(content, project)) {
    return { error: `File exists but no valid header for project '${project}'. Refusing to append.` };
  }
  if (!isNew && isDuplicate(content, id)) {
    return { written: false, id, filePath, reason: "duplicate" };
  }

  const entryText = formatEntry(entry);
  if (isNew) {
    const header = `# MCP Tool Feedback Log\n${buildHeader(project, serverName, serverVersion)}\n<!-- DO NOT EDIT manually — managed by report_tool_feedback tool -->\n`;
    content = header + SEPARATOR + entryText + SEPARATOR;
  } else {
    // Drop a trailing separator first — otherwise every append leaves one more "---" behind.
    content = stripTrailingSeparator(content) + SEPARATOR + entryText + SEPARATOR;
  }

  try { fs.writeFileSync(filePath, content, "utf-8"); } catch {
    return { error: `Cannot write to: ${filePath}` };
  }

  return { written: true, id, filePath };
}

// ── Feedback archive (.mcp/FEEDBACK_ARCHIVE.md) ─────────────
// Closed entries are moved out of the active log so FEEDBACK.md stays small and
// readable. The archive is append-first: a block is written to the archive before it
// is removed from FEEDBACK.md, so a crash can at worst leave a duplicate, never lose
// an entry.

function activeFeedbackPath(projectRoot: string): string {
  return path.join(projectRoot, FEEDBACK_DIR, FEEDBACK_FILE);
}

function feedbackArchivePath(projectRoot: string): string {
  return path.join(projectRoot, FEEDBACK_DIR, ARCHIVE_FILE);
}

function readFileOrNull(filePath: string): string | null {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return null; }
}

/** Drop trailing blank lines and our own "---" separator from a line range (end exclusive). */
function trimTrailingSeparator(lines: string[], from: number, end: number): number {
  while (end > from && lines[end - 1]!.trim() === "") end--;
  if (end > from && lines[end - 1]!.trim() === "---") {
    end--;
    while (end > from && lines[end - 1]!.trim() === "") end--;
  }
  return end;
}

/** Split a feedback log into its preamble (header) and its individual entry blocks. */
function splitFeedbackBlocks(content: string): { preamble: string; blocks: string[] } {
  const lines = content.split(/\r?\n/);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.startsWith("## [")) starts.push(i);
  if (starts.length === 0) return { preamble: content.trimEnd(), blocks: [] };
  const preamble = lines.slice(0, trimTrailingSeparator(lines, 0, starts[0]!)).join("\n");
  const blocks: string[] = [];
  for (let b = 0; b < starts.length; b++) {
    const from = starts[b]!;
    const to = b + 1 < starts.length ? starts[b + 1]! : lines.length;
    // Keep the block itself verbatim, drop only the separator we insert between blocks.
    blocks.push(lines.slice(from, trimTrailingSeparator(lines, from, to)).join("\n"));
  }
  return { preamble, blocks };
}

function isClosedBlock(block: string): boolean {
  return /^> \*\*status:\*\* closed\s*$/m.test(block);
}

function blockId(block: string): string {
  return (block.match(/^> \*\*id:\*\* (.+)$/m) ?? [])[1]?.trim() ?? "";
}

function headerCommentOf(preamble: string, fallback: string): string {
  return (preamble.match(/^<!-- project=.*-->$/m) ?? [fallback])[0]!;
}

/**
 * Move every closed entry from .mcp/FEEDBACK.md into .mcp/FEEDBACK_ARCHIVE.md.
 * Self-healing: it archives all closed entries currently in the active log, so a
 * single call also migrates entries closed before this feature existed.
 * Idempotent — entries already in the archive are skipped, never duplicated.
 */
export function archiveClosedEntries(projectRoot: string): ArchiveResult | FeedbackError {
  const sourcePath = activeFeedbackPath(projectRoot);
  const archivePath = feedbackArchivePath(projectRoot);
  const content = readFileOrNull(sourcePath);
  if (content === null) return { error: `Feedback file not found: ${sourcePath}` };

  const { preamble, blocks } = splitFeedbackBlocks(content);
  const closedBlocks = blocks.filter(isClosedBlock);
  if (closedBlocks.length === 0) return { archived: 0, ids: [], filePath: archivePath, sourcePath };

  let archive = readFileOrNull(archivePath);
  if (archive === null) {
    archive = `${ARCHIVE_TITLE}\n${headerCommentOf(preamble, "<!-- project=unknown -->")}\n` +
      `<!-- Closed entries moved out of FEEDBACK.md — managed by close_feedback tool -->\n`;
  }

  const moved: string[] = [];
  for (const block of closedBlocks) {
    const id = blockId(block);
    if (id && archive.includes(`> **id:** ${id}`)) continue;
    archive = archive.trimEnd() + SEPARATOR + block + SEPARATOR;
    moved.push(id);
  }
  if (moved.length === 0) return { archived: 0, ids: [], filePath: archivePath, sourcePath };

  try {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, archive, "utf-8");
  } catch {
    return { error: `Cannot write archive: ${archivePath}` };
  }

  const remaining = blocks.filter((block) => !(isClosedBlock(block) && moved.includes(blockId(block))));
  const body = remaining.length > 0 ? `${SEPARATOR}${remaining.join(SEPARATOR)}${SEPARATOR}` : "\n";
  try { fs.writeFileSync(sourcePath, `${preamble}\n${body}`, "utf-8"); } catch {
    return { error: `Entries archived to ${archivePath}, but cannot update ${sourcePath}` };
  }
  return { archived: moved.length, ids: moved, filePath: archivePath, sourcePath };
}

export interface FeedbackListOptions {
  type?: "bug" | "improvement" | "feature_request";
  tool?: string;
  status?: "open" | "closed";
  /** true = read .mcp/FEEDBACK_ARCHIVE.md (entries moved out of the active log) instead of .mcp/FEEDBACK.md. */
  archived?: boolean;
}

export function readFeedbackEntries(projectRoot: string, options: FeedbackListOptions = {}): FeedbackEntry[] {
  const filePath = options.archived ? feedbackArchivePath(projectRoot) : activeFeedbackPath(projectRoot);
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }
  const entries: FeedbackEntry[] = [];
  const blocks = content.split(/^## \[/m).slice(1);
  for (const block of blocks) {
    const typeMatch = block.match(/^(BUG|IMPROVEMENT|FEATURE REQUEST)\] (.+)/);
    if (!typeMatch) continue;
    const type = typeMatch[1]!.toLowerCase().replace(" ", "_") as FeedbackEntry["type"];
    const title = typeMatch[2]!;
    const id = (block.match(/> \*\*id:\*\* (.+)/) ?? [])[1]?.trim() ?? "";
    const date = (block.match(/> \*\*date:\*\* (.+)/) ?? [])[1]?.trim() ?? "";
    const tool = (block.match(/> \*\*tool:\*\* (.+)/) ?? [])[1]?.trim() ?? "";
    const status = (block.match(/> \*\*status:\*\* (.+)/) ?? [])[1]?.trim() as FeedbackEntry["status"] ?? "open";
    const resolution = (block.match(/> \*\*resolution:\*\* (.+)/) ?? [])[1]?.trim();
    const closedAt = (block.match(/> \*\\*closedAt:\\*\\* (.+)/) ?? [])[1]?.trim();
    const desc = block.split("\n\n")[1]?.trim() ?? "";
    entries.push({ id, date, tool, type, status, title, description: desc, resolution, closedAt });
  }
  // Apply filters
  let filtered = entries;
  if (options.type) filtered = filtered.filter((e) => e.type === options.type);
  if (options.tool) filtered = filtered.filter((e) => e.tool === options.tool);
  if (options.status) filtered = filtered.filter((e) => e.status === options.status);
  return filtered;
}

/**
 * Close an existing feedback entry by ID — sets status to "closed", optionally adds
 * resolution text, then moves all closed entries out of the active log into
 * .mcp/FEEDBACK_ARCHIVE.md (so FEEDBACK.md keeps holding open items only).
 * Returns error if the entry is not found or already closed.
 */
export function closeFeedback(
  projectRoot: string,
  id: string,
  resolution?: string,
): CloseResult | FeedbackError {
  const filePath = activeFeedbackPath(projectRoot);
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch {
    return { error: `Feedback file not found: ${filePath}` };
  }
  const idMarker = `> **id:** ${id}`;
  if (!content.includes(idMarker)) {
    const archivePath = feedbackArchivePath(projectRoot);
    const archived = readFileOrNull(archivePath);
    if (archived && archived.includes(idMarker)) {
      return { error: `Entry '${id}' is already closed (archived in ${ARCHIVE_FILE})` };
    }
    return { error: `Entry with id '${id}' not found` };
  }

  // Find the status line after the id marker in this block
  const blockStart = content.indexOf(idMarker);
  const statusLineStart = content.indexOf("> **status:** ", blockStart);
  if (statusLineStart === -1 || statusLineStart > blockStart + 500) {
    return { error: `Could not find status line for entry '${id}'` };
  }
  const beforeStatus = content.slice(0, statusLineStart);
  const afterStatus = content.slice(statusLineStart);
  // Replace only the first "status: open" after this id
  const closeTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ").replace(/Z$/, " UTC");
  const closedLine = resolution
    ? `> **status:** closed\n> **resolution:** ${resolution}\n> **closedAt:** ${closeTime}`
    : `> **status:** closed\n> **closedAt:** ${closeTime}`;
  const newAfterStatus = afterStatus.replace(
    /^> \*\*status:\*\* open/m,
    closedLine,
  );
  if (newAfterStatus === afterStatus) {
    return { error: `Entry '${id}' is already closed` };
  }
  const newContent = beforeStatus + newAfterStatus;
  try { fs.writeFileSync(filePath, newContent, "utf-8"); } catch {
    return { error: `Cannot write to: ${filePath}` };
  }
  // Move every closed entry (this one plus any leftovers) out of the active log.
  const archiveResult = archiveClosedEntries(projectRoot);
  return {
    updated: true,
    id,
    filePath,
    archived: "error" in archiveResult ? [] : archiveResult.ids,
    archivePath: feedbackArchivePath(projectRoot),
  };
}
