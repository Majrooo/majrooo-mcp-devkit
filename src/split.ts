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
  rust: /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/,
  typescript: /^(?:export\s+)?(?:function|class|interface|type|const|enum|async\s+function)\s+(\w+)/,
  python: /^(?:class|def|async\s+def)\s+(\w+)/,
  cpp: /^(?:class|struct)\s+(\w+)/,
};

interface DeclBlock { name: string; startLine: number; endLine: number; }

interface ImplBlockInfo {
  typeName: string;
  startLine: number;
  endLine: number;
}

const IMPL_REGEX = /^impl(?:\s*<[^>]*>)?\s+(\w+)(?:\s+for\s+(\w+))?/;

/**
 * Scan upward from lineIndex to find the enclosing #[cfg(...)] attribute.
 * Tracks brace depth to correctly handle nested blocks.
 * Returns the cfg predicate string (e.g. "not(debug_assertions)") or null.
 */
function findEnclosingCfg(lines: string[], lineIndex: number): string | null {
  let depth = 0;
  for (let i = lineIndex - 1; i >= Math.max(0, lineIndex - 50); i--) {
    const line = lines[i]!;
    // Count braces to track block depth
    for (let j = 0; j < line.length; j++) {
      if (line[j] === "{") depth++;
      if (line[j] === "}") depth--;
    }
    // When depth becomes positive, we found the opening { of a block containing our line
    if (depth > 0) {
      // Scan upward from this line for #[cfg(...)]
      for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
        const m = lines[k]!.match(/#\[cfg\((.+)\)\]/);
        if (m) return m[1]!;
        const t = lines[k]!.trim();
        if (t !== "" && !t.startsWith("//") && !t.startsWith("#[") && !t.startsWith("#![")) break;
      }
      depth = 0; // reset, keep scanning
    }
  }
  return null;
}

function extractDeclBlocks(lines: string[], lang: string): { blocks: DeclBlock[]; implBlocks: ImplBlockInfo[] } {
  const regex = DECL_REGEX[lang];
  if (!regex) return { blocks: [], implBlocks: [] };
  const blocks: DeclBlock[] = [];
  const implBlocks: ImplBlockInfo[] = [];
  const occupied = new Set<number>();

  // First pass: find impl blocks (Rust) and mark their lines as occupied
  // so that methods inside impl blocks are not extracted as standalone declarations.
  if (lang === "rust") {
    for (let i = 0; i < lines.length; i++) {
      const m = IMPL_REGEX.exec(lines[i]!);
      if (m) {
        const annotStart = scanUpwardForAnnotations(lines, i);
        const braceStart = findBraceStart(lines, i);
        const blockEnd = findBraceBlockEnd(lines, braceStart);
        // impl Foo → typeName = Foo;  impl Trait for Foo → typeName = Foo
        const typeName = m[2] || m[1];
        for (let l = annotStart; l <= blockEnd; l++) occupied.add(l);
        implBlocks.push({ typeName, startLine: annotStart, endLine: blockEnd });
      }
    }
  }

  // Second pass: find declarations
  for (let i = 0; i < lines.length; i++) {
    if (occupied.has(i)) continue;
    const m = regex.exec(lines[i]!);
    if (!m) continue;
    const name = m[1]!;
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
  return { blocks, implBlocks };
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

function collectImportLines(lines: string[], lang: string): string[] {
  const imports: string[] = [];
  let inMultiLine = false; // collecting a multi-line import block
  for (const line of lines) {
    const trimmed = line.trim();

    // Continue collecting multi-line import block
    if (inMultiLine) {
      imports.push(line);
      if (/;\s*$/.test(trimmed) || (trimmed === ");" && lang === "python")) {
        inMultiLine = false;
      }
      continue;
    }

    if (trimmed.length === 0) continue;

    if (lang === "rust" && /^use\s+/.test(trimmed)) {
      imports.push(line);
      if (/\{[^}]*$/.test(trimmed) && !/;\s*$/.test(trimmed)) inMultiLine = true;
    } else if (lang === "typescript" && /^import\s+/.test(trimmed)) {
      imports.push(line);
      if (/\{[^}]*$/.test(trimmed) && !/from\s+/.test(trimmed)) inMultiLine = true;
    } else if (lang === "python" && /^(import|from)\s+/.test(trimmed)) {
      imports.push(line);
      if (/\([^)]*$/.test(trimmed)) inMultiLine = true;
    } else if (lang === "cpp" && /^#include\s+/.test(trimmed)) {
      imports.push(line);
    }
  }
  return imports;
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
  implBlocks?: number;
  lineRange: [number, number];
  targetFile: string;
}

export interface SplitResult {
  dryRun: boolean;
  sourceFile: string;
  language: string;
  imports?: string[];
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
  const { blocks, implBlocks: allImplBlocks } = extractDeclBlocks(lines, lang);
  const blockByName = new Map<string, DeclBlock>();
  for (const b of blocks) blockByName.set(b.name, b);
  const imports = collectImportLines(lines, lang);

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
    // Count impl blocks associated with extracted types
    const typeNames = new Set<string>();
    for (const r of resolved) {
      // Scan block lines to find the actual type declaration (skip annotations/comments)
      for (let li = r.block.startLine; li <= r.block.endLine; li++) {
        const trimmed = lines[li]!.trim();
        if (/^\/\/|^\/\*|^\*|^#\[|^@|^"""/.test(trimmed)) continue; // skip comments & annotations
        const typeMatch = /\b(?:struct|enum|trait|class|interface)\s+(\w+)/.exec(trimmed);
        if (typeMatch) { typeNames.add(typeMatch[1]!); break; }
      }
    }
    const implCount = allImplBlocks.filter((impl) => typeNames.has(impl.typeName)).length;
    preview.push({
      module: group.module,
      symbols: group.symbols,
      implBlocks: implCount > 0 ? implCount : undefined,
      lineRange: [resolved[0]!.block.startLine + 1, resolved[resolved.length - 1]!.block.endLine + 1],
      targetFile: path.join(targetDir, group.module),
    });
  }

  const idxFile = generateIndex ? path.join(targetDir, indexFilename(lang)) : undefined;
  const idxContent = idxFile ? generateIndexContent(grouping.map((g) => g.module), lang) : undefined;

  if (dryRun) return { dryRun: true, sourceFile: filePath, language: lang, imports: imports.length > 0 ? imports : undefined, preview, indexFile: idxFile, indexContent: idxContent };

  // ── Cross-module reference detection ──────────────────────
  // Build map: symbol name → module name
  const symbolToModule = new Map<string, string>();
  for (const group of grouping) {
    for (const sym of group.symbols) symbolToModule.set(sym, group.module);
  }

  // Write mode
  const importBlock = imports.length > 0 ? imports.join("\n") + "\n\n" : "";
  for (const p of preview) {
    const sortedSymbols = grouping.find((g) => g.module === p.module)!.symbols
      .map((s) => blockByName.get(s)!).sort((a, b) => a.startLine - b.startLine);

    // Determine which types are being extracted (for impl block association)
    const typeNames = new Set<string>();
    for (const b of sortedSymbols) {
      // Scan block lines to find the actual type declaration (skip annotations/comments)
      for (let li = b.startLine; li <= b.endLine; li++) {
        const trimmed = lines[li]!.trim();
        if (/^\/\/|^\/\*|^\*|^#\[|^@|^"""/.test(trimmed)) continue; // skip comments & annotations
        const typeMatch = /\b(?:struct|enum|trait|class|interface)\s+(\w+)/.exec(trimmed);
        if (typeMatch) { typeNames.add(typeMatch[1]!); break; }
      }
    }

    // Find associated impl blocks, preserving source order
    const associatedImpls = allImplBlocks
      .filter((impl) => typeNames.has(impl.typeName))
      .sort((a, b) => a.startLine - b.startLine);

    // Detect cross-module references: scan decl blocks + impl blocks for symbols from OTHER modules
    const crossRefs = new Map<string, string | null>(); // symbol → cfg predicate or null
    const ownSymbols = new Set(grouping.find((g) => g.module === p.module)!.symbols);
    const symbolCfgMap = new Map<string, Set<string | null>>(); // symbol → set of cfg predicates found

    const scanForCrossRefs = (startLine: number, endLine: number) => {
      for (let li = startLine; li <= endLine; li++) {
        const lineText = lines[li]!;
        for (const [sym, mod] of symbolToModule) {
          if (mod === p.module) continue;
          if (ownSymbols.has(sym)) continue;
          if (new RegExp(`\\b${sym}\\b`).test(lineText)) {
            if (!symbolCfgMap.has(sym)) symbolCfgMap.set(sym, new Set());
            const cfg = findEnclosingCfg(lines, li);
            symbolCfgMap.get(sym)!.add(cfg);
          }
        }
      }
    };
    for (const b of sortedSymbols) scanForCrossRefs(b.startLine, b.endLine);
    for (const impl of associatedImpls) scanForCrossRefs(impl.startLine, impl.endLine);

    // Resolve: if all usages of a symbol share the same cfg → use it; otherwise null (allow unused)
    for (const [sym, cfgs] of symbolCfgMap) {
      const unique = [...cfgs];
      crossRefs.set(sym, unique.length === 1 ? unique[0]! : null);
    }

    // Build file content: imports + cross-module imports + declarations + impl blocks
    const declParts = sortedSymbols.map((b) => lines.slice(b.startLine, b.endLine + 1).join("\n"));
    const implParts = associatedImpls.map((impl) => lines.slice(impl.startLine, impl.endLine + 1).join("\n"));
    const allParts = [...declParts, ...implParts];

    // Generate cross-module imports with cfg-aware wrapping
    const crossImportLines: string[] = [];
    const sortedCrossRefs = [...crossRefs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [sym, cfg] of sortedCrossRefs) {
      if (cfg) {
        crossImportLines.push(`#[cfg(${cfg})]`);
      }
      crossImportLines.push(`use super::${sym};`);
    }
    // If any symbol has mixed cfg (null), add a blanket #[allow(unused_imports)]
    const hasMixed = sortedCrossRefs.some(([, cfg]) => cfg === null);
    const allowLine = hasMixed && crossImportLines.length > 0 ? "#[allow(unused_imports)]\n" : "";
    const crossImportBlock = crossImportLines.length > 0
      ? allowLine + crossImportLines.join("\n") + "\n\n"
      : "";
    const fileContent = importBlock + crossImportBlock + allParts.join("\n\n") + "\n";

    try { fs.writeFileSync(p.targetFile, fileContent, "utf-8"); } catch (err) {
      return { error: `Failed to write ${p.targetFile}: ${err}` };
    }
  }
  if (idxFile && idxContent) {
    try { fs.writeFileSync(idxFile, idxContent, "utf-8"); } catch (err) {
      return { error: `Failed to write index file ${idxFile}: ${err}` };
    }
  }
  return { dryRun: false, sourceFile: filePath, language: lang, imports: imports.length > 0 ? imports : undefined, preview, indexFile: idxFile, indexContent: idxContent };
}

