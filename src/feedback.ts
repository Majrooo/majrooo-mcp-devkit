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
const SEPARATOR = "\n---\n";

export interface FeedbackEntry {
  id: string;
  date: string;
  tool: string;
  type: "bug" | "improvement" | "feature_request";
  status: "open";
  title: string;
  description: string;
  reproduction?: string;
  expected?: string;
  suggestion?: string;
}

export interface FeedbackResult { written: boolean; id: string; filePath: string; reason?: string; }
export interface FeedbackError { error: string; }

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

function formatEntry(entry: FeedbackEntry): string {
  const lines: string[] = [];
  lines.push(`## [${entry.type.toUpperCase().replace("_", " ")}] ${entry.title}`);
  lines.push(`> **id:** ${entry.id}`);
  lines.push(`> **date:** ${entry.date}`);
  lines.push(`> **tool:** ${entry.tool}`);
  lines.push(`> **type:** ${entry.type}`);
  lines.push(`> **status:** ${entry.status}`);
  lines.push("");
  lines.push(entry.description);
  if (entry.reproduction) lines.push("", `**Reproduction:** ${entry.reproduction}`);
  if (entry.expected) lines.push(`**Expected:** ${entry.expected}`);
  if (entry.suggestion) lines.push(`**Suggestion:** ${entry.suggestion}`);
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
  const date = new Date().toISOString().split("T")[0]!;
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
    content = content.trimEnd() + SEPARATOR + entryText + SEPARATOR;
  }

  try { fs.writeFileSync(filePath, content, "utf-8"); } catch {
    return { error: `Cannot write to: ${filePath}` };
  }

  return { written: true, id, filePath };
}

export interface FeedbackListOptions {
  type?: "bug" | "improvement" | "feature_request";
  tool?: string;
  status?: "open" | "closed";
}

export function readFeedbackEntries(projectRoot: string, options: FeedbackListOptions = {}): FeedbackEntry[] {
  const filePath = path.join(projectRoot, FEEDBACK_DIR, FEEDBACK_FILE);
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
    const desc = block.split("\n\n")[1]?.trim() ?? "";
    entries.push({ id, date, tool, type, status, title, description: desc });
  }
  // Apply filters
  let filtered = entries;
  if (options.type) filtered = filtered.filter((e) => e.type === options.type);
  if (options.tool) filtered = filtered.filter((e) => e.tool === options.tool);
  if (options.status) filtered = filtered.filter((e) => e.status === options.status);
  return filtered;
}
