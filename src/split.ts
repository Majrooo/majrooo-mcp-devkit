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
// src/split.ts — split a file into multiple files based on top-level declarations.
import fs from "fs";
import path from "path";
import {
  scanUpwardForAnnotations,
  isIndentLanguage,
  findBraceBlockEnd,
  findIndentBlockEnd,
  findBraceStart,
} from "./symbols.js";

const EXT_TO_LANG: Record<string, string> = {
  ".rs": "rust", ".ts": "typescript", ".tsx": "typescript",
  ".js": "typescript", ".jsx": "typescript",
  ".py": "python", ".cpp": "cpp", ".h": "cpp", ".hpp": "cpp", ".c": "cpp",
};

export function detectLanguage(filePath: string): string | undefined {
  return EXT_TO_LANG[path.extname(filePath).toLowerCase()];
}

const DECL_REGEX: Record<string, RegExp> = {
  rust: /^pub\s+(fn|struct|enum|trait|type|const|static)\s+(\w+)/,
  typescript: /^export\s+(function|class|interface|type|const|enum|async\s+function)\s+(\w+)/,
  python: /^(class|def|async\s+def)\s+(\w+)/,
  cpp: /^(class|struct)\s+(\w+)/,
};

interface DeclBlock { name: string; startLine: number; endLine: number; }

function extractDeclBlocks(lines: string[], lang: string): DeclBlock[] {
  const regex = DECL_REGEX[lang];
  if (!regex) return [];
  const blocks: DeclBlock[] = [];
  const occupied = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (occupied.has(i)) continue;
    const m = regex.exec(lines[i]!);
    if (!m) continue;
    const name = m[2]!;
    const annotStart = scanUpwardForAnnotations(lines, i);
    let alreadyClaimed = false;
    for (let a = annotStart; a < i; a++) { if (occupied.has(a)) { alreadyClaimed = true; break; } }
    if (alreadyClaimed) continue;
    let blockEnd: number;
    if (isIndentLanguage(lines, i)) { blockEnd = findIndentBlockEnd(lines, i); }
    else { blockEnd = findBraceBlockEnd(lines, findBraceStart(lines, i)); }
    for (let l = annotStart; l <= blockEnd; l++) occupied.add(l);
    blocks.push({ name, startLine: annotStart, endLine: blockEnd });
  }
  return blocks;
}

function generateIndexContent(modules: string[], lang: string): string {
  const stem = (f: string) => path.basename(f, path.extname(f));
  switch (lang) {
    case "rust": return modules.map((m) => `pub mod ${stem(m)};\npub use ${stem(m)}::*;`).join("\n") + "\n";
    case "typescript": return modules.map((m) => `export * from './${stem(m)}';`).join("\n") + "\n";
    case "python": return modules.map((m) => `from .${stem(m)} import *`).join("\n") + "\n";
    default: return "";
  }
}

function indexFilename(lang: string): string {
  switch (lang) {
    case "rust": return "mod.rs";
    case "typescript": return "index.ts";
    case "python": return "__init__.py";
    default: return "index.ts";
  }
}

// ── Public types & main function ────────────────────────────

export interface SplitGroup { module: string; symbols: string[]; }

export interface SplitOptions {
  targetDir?: string;
  language?: string;
  generateIndex?: boolean;
  dryRun?: boolean;
  overwrite?: boolean;
}

export interface SplitPreview {
  module: string;
  symbols: string[];
  lineRange: [number, number];
  targetFile: string;
}

export interface SplitResult {
  dryRun: boolean;
  sourceFile: string;
  language: string;
  preview: SplitPreview[];
  indexFile?: string;
  indexContent?: string;
}

export interface SplitError { error: string; }

export function splitFileByDeclarations(
  filePath: string,
  grouping: SplitGroup[],
  options: SplitOptions = {},
): SplitResult | SplitError {
  const { targetDir = path.dirname(filePath), language, generateIndex = true, dryRun = true, overwrite = false } = options;
  const lang = language ?? detectLanguage(filePath);
  if (!lang) return { error: `Cannot detect language for file: ${filePath}` };

  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch {
    return { error: `Cannot read file: ${filePath}` };
  }
  const lines = content.split(/\r?\n/);
  const blocks = extractDeclBlocks(lines, lang);
  const blockByName = new Map<string, DeclBlock>();
  for (const b of blocks) blockByName.set(b.name, b);

  // Validate target dir exists
  try { if (!fs.existsSync(targetDir) && !dryRun) fs.mkdirSync(targetDir, { recursive: true }); } catch {
    return { error: `Cannot create target directory: ${targetDir}` };
  }

  // Overwrite check
  if (!dryRun && !overwrite) {
    for (const g of grouping) {
      const t = path.join(targetDir, g.module);
      if (fs.existsSync(t)) return { error: `Target file already exists (overwrite: false): ${t}` };
    }
  }

  // Source overlap check
  if (!dryRun && path.resolve(targetDir) === path.resolve(path.dirname(filePath))) {
    for (const g of grouping) {
      if (g.module === path.basename(filePath)) return { error: `Module '${g.module}' would overwrite source file` };
    }
  }

  const preview: SplitPreview[] = [];
  for (const group of grouping) {
    const resolved: { name: string; block: DeclBlock }[] = [];
    const unknowns: string[] = [];
    for (const sym of group.symbols) {
      const block = blockByName.get(sym);
      if (block) resolved.push({ name: sym, block });
      else unknowns.push(sym);
    }
    if (unknowns.length > 0) return { error: `Symbols not found in source: ${unknowns.join(", ")}` };
    resolved.sort((a, b) => a.block.startLine - b.block.startLine);
    preview.push({
      module: group.module,
      symbols: group.symbols,
      lineRange: [resolved[0]!.block.startLine + 1, resolved[resolved.length - 1]!.block.endLine + 1],
      targetFile: path.join(targetDir, group.module),
    });
  }

  const idxFile = generateIndex ? path.join(targetDir, indexFilename(lang)) : undefined;
  const idxContent = idxFile ? generateIndexContent(grouping.map((g) => g.module), lang) : undefined;

  if (dryRun) return { dryRun: true, sourceFile: filePath, language: lang, preview, indexFile: idxFile, indexContent: idxContent };

  // Write mode
  for (const p of preview) {
    const sortedSymbols = grouping.find((g) => g.module === p.module)!.symbols
      .map((s) => blockByName.get(s)!).sort((a, b) => a.startLine - b.startLine);
    const fileContent = sortedSymbols.map((b) => lines.slice(b.startLine, b.endLine + 1).join("\n")).join("\n\n") + "\n";
    try { fs.writeFileSync(p.targetFile, fileContent, "utf-8"); } catch (err) {
      return { error: `Failed to write ${p.targetFile}: ${err}` };
    }
  }
  if (idxFile && idxContent) {
    try { fs.writeFileSync(idxFile, idxContent, "utf-8"); } catch (err) {
      return { error: `Failed to write index file ${idxFile}: ${err}` };
    }
  }
  return { dryRun: false, sourceFile: filePath, language: lang, preview, indexFile: idxFile, indexContent: idxContent };
}

