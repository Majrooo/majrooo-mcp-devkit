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
// src/symbols.ts — language-agnostic symbol search and code-block extraction.
import fs from "fs";
import path from "path";

// ── Default paths to exclude from scanning ─────────────────

const DEFAULT_EXCLUDE: readonly string[] = [
  ".git", "node_modules", "target", "build", "dist",
  "__pycache__", ".next", ".nuxt", "coverage",
];

const DEFAULT_EXTENSIONS: readonly string[] = [
  ".rs", ".ts", ".py", ".js", ".jsx", ".tsx",
  ".cpp", ".h", ".hpp", ".c", ".cs", ".java", ".go",
];

// ── universal_find_references ───────────────────────────────

export interface ReferenceMatch {
  line: number;
  column: number;
  context: string;
  role?: "declaration" | "import" | "usage";
}

export interface FileReferences {
  file: string;
  matches: ReferenceMatch[];
}

export interface FindReferencesResult {
  symbol: string;
  totalMatches: number;
  files: FileReferences[];
}

export interface FindReferencesOptions {
  fileExtensions?: string[];
  excludePatterns?: string[];
  contextLines?: number;
  language?: "rust" | "typescript" | "python" | "cpp";
}

// ── Language-aware secondary patterns (role detection) ──────

interface LanguagePatterns {
  declaration: RegExp;
  import: RegExp;
}

const LANGUAGE_PATTERNS: Record<string, LanguagePatterns> = {
  rust: {
    declaration: /^pub\s+(fn|struct|enum|trait|type|const|static)\s+/,
    import: /^\s*use\s+/,
  },
  typescript: {
    declaration: /^export\s+(function|class|interface|type|const|enum|async\s+function)\s+/,
    import: /^\s*import\s+/,
  },
  python: {
    declaration: /^\s*(class|def|async\s+def)\s+/,
    import: /^\s*(import|from)\s+/,
  },
  cpp: {
    declaration: /^\s*(class|struct)\s+\w/,
    import: /^\s*#include\s+/,
  },
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectRole(lineText: string, symbol: string, lang?: string): "declaration" | "import" | "usage" {
  if (!lang) return "usage";
  const patterns = LANGUAGE_PATTERNS[lang];
  if (!patterns) return "usage";
  if (patterns.declaration.test(lineText)) {
    const rest = lineText.replace(patterns.declaration, "");
    if (new RegExp(`\\b${escapeRegex(symbol)}\\b`).test(rest)) return "declaration";
  }
  if (patterns.import.test(lineText)) {
    if (new RegExp(`\\b${escapeRegex(symbol)}\\b`).test(lineText)) return "import";
  }
  return "usage";
}

function isExcluded(dirName: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (dirName === p || dirName === p.replace(/^\*/, "")) return true;
  }
  return false;
}

function collectFiles(dir: string, extensions: readonly string[], excludes: readonly string[]): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isExcluded(entry.name, excludes)) {
        results.push(...collectFiles(fullPath, extensions, excludes));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) results.push(fullPath);
    }
  }
  return results;
}

/**
 * Find all occurrences of a symbol across a workspace.
 * @param symbol  The symbol to search for (word-boundary match).
 * @param root    The workspace root directory.
 * @param options Optional: fileExtensions, excludePatterns, contextLines, language.
 */
export function universalFindReferences(
  symbol: string,
  root: string,
  options: FindReferencesOptions = {},
): FindReferencesResult {
  const {
    fileExtensions = [...DEFAULT_EXTENSIONS],
    excludePatterns = [...DEFAULT_EXCLUDE],
    contextLines = 1,
    language,
  } = options;

  const wordBoundary = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
  const files = collectFiles(root, fileExtensions, excludePatterns);
  const fileRefs: FileReferences[] = [];
  let totalMatches = 0;

  for (const filePath of files) {
    let content: string;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { continue; }

    const lines = content.split(/\r?\n/);
    const matches: ReferenceMatch[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const col = line.search(wordBoundary);
      if (col === -1) continue;
      const startCtx = Math.max(0, i - contextLines);
      const endCtx = Math.min(lines.length - 1, i + contextLines);
      const context = lines.slice(startCtx, endCtx + 1).join("\n");
      matches.push({
        line: i + 1,
        column: col + 1,
        context,
        role: language ? detectRole(line, symbol, language) : undefined,
      });
      totalMatches++;
    }

    if (matches.length > 0) {
      const rel = path.relative(root, filePath).replace(/\\/g, "/");
      fileRefs.push({ file: rel, matches });
    }
  }

  return { symbol, totalMatches, files: fileRefs };
}

// ── extract_code_block ──────────────────────────────────────

export interface ExtractBlockResult {
  file: string;
  symbol: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ExtractBlockMultipleResult {
  file: string;
  symbol: string;
  matches: ExtractBlockResult[];
}

export interface ExtractBlockError {
  error: string;
}

export interface ExtractBlockOptions {
  contextLines?: number;
}

// ── String/comment skip state machine ───────────────────────

interface TokenizerState {
  inString: false | "'" | '"' | "`";
  inLineComment: boolean;
  inBlockComment: boolean;
  escapeNext: boolean;
}

function createInitialState(): TokenizerState {
  return { inString: false, inLineComment: false, inBlockComment: false, escapeNext: false };
}

/** Advance the tokenizer state by one char. Returns true if consumed (inside string/comment). */
function advanceTokenizer(state: TokenizerState, ch: string, nextCh: string | undefined): boolean {
  if (state.inLineComment) {
    if (ch === "\n") state.inLineComment = false;
    return true;
  }
  if (state.inBlockComment) {
    if (ch === "*" && nextCh === "/") state.inBlockComment = false;
    return true;
  }
  if (state.escapeNext) { state.escapeNext = false; return true; }
  if (ch === "\\") { if (state.inString) { state.escapeNext = true; return true; } return false; }
  if (state.inString) {
    if (state.inString === ch) { state.inString = false; return true; }
    return true;
  }
  if (ch === "/" && nextCh === "/") { state.inLineComment = true; return true; }
  if (ch === "/" && nextCh === "*") { state.inBlockComment = true; return true; }
  if (ch === "#" && nextCh !== "!") { state.inLineComment = true; return true; }
  if (ch === "'" || ch === '"' || ch === "`") { state.inString = ch; return true; }
  return false;
}

// ── Annotation / block boundary helpers ─────────────────────

function isAnnotationLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^#\[/.test(trimmed)) return true;  // Rust #[...]
  if (/^@/.test(trimmed)) return true;    // Python @decorator
  if (/^(\/\/\/|\/\*\*|\/\/!)/.test(trimmed)) return true;  // Doc comments
  if (/^"""/.test(trimmed) || /^'''/.test(trimmed)) return true;  // Python docstrings
  if (/^#/.test(trimmed)) return true;    // Hash comments
  if (/^\*/.test(trimmed)) return true;   // C-style block comment continuation
  return false;
}

function scanUpwardForAnnotations(lines: string[], fromLine: number): number {
  let start = fromLine;
  let i = fromLine - 1;
  while (i >= 0) {
    if (isAnnotationLine(lines[i]!)) {
      start = i;
      i--;
    } else if (lines[i]!.trim() === "") {
      break;
    } else {
      break;
    }
  }
  return start;
}

function isIndentLanguage(lines: string[], declLine: number): boolean {
  const decl = lines[declLine]!.trim();
  if (/^(class|def|async\s+def)\s+/.test(decl)) {
    if (decl.endsWith(":")) return true;
    for (let j = declLine + 1; j < Math.min(lines.length, declLine + 3); j++) {
      const next = lines[j];
      if (!next || next.trim() === "") continue;
      const declIndent = lines[declLine]!.search(/\S/);
      const nextIndent = next.search(/\S/);
      if (nextIndent > declIndent) return true;
      break;
    }
  }
  return false;
}

function findBraceBlockEnd(lines: string[], openLine: number): number {
  const state = createInitialState();
  let depth = 0;
  let foundOpen = false;
  for (let i = openLine; i < lines.length; i++) {
    const line = lines[i]!;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      const nextCh = j + 1 < line.length ? line[j + 1] : undefined;
      if (advanceTokenizer(state, ch, nextCh)) continue;
      if (ch === "{") { depth++; foundOpen = true; }
      else if (ch === "}") {
        depth--;
        if (foundOpen && depth === 0) return i;
      }
    }
    state.inLineComment = false;
  }
  return lines.length - 1;
}

function findIndentBlockEnd(lines: string[], declLine: number): number {
  const declIndent = lines[declLine]!.search(/\S/);
  for (let i = declLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const currentIndent = line.search(/\S/);
    if (currentIndent <= declIndent) return i - 1;
  }
  return lines.length - 1;
}

function findBraceStart(lines: string[], declLine: number): number {
  if (lines[declLine]!.includes("{")) return declLine;
  for (let j = declLine + 1; j < Math.min(lines.length, declLine + 5); j++) {
    if (lines[j]!.includes("{")) return j;
  }
  return declLine;
}

// ── extractCodeBlock ────────────────────────────────────────

function findDeclarationLine(lines: string[], symbol: string): number {
  const pattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i]!)) return i;
  }
  return -1;
}

/**
 * Extract the full text of a function, struct, class, or method from a file.
 * Returns precise line range + content. When the symbol matches multiple
 * locations (overloaded name), returns all matches.
 */
export function extractCodeBlock(
  filePath: string,
  symbol: string,
  options: ExtractBlockOptions = {},
): ExtractBlockResult | ExtractBlockMultipleResult | ExtractBlockError {
  const { contextLines = 0 } = options;

  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch {
    return { error: `Cannot read file: ${filePath}` };
  }

  const lines = content.split(/\r?\n/);
  const wordBoundary = new RegExp(`\\b${escapeRegex(symbol)}\\b`);

  const matchingLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (wordBoundary.test(lines[i]!)) matchingLines.push(i);
  }
  if (matchingLines.length === 0) {
    return { error: `Symbol '${symbol}' not found` };
  }

  const results: ExtractBlockResult[] = [];
  for (const declLine of matchingLines) {
    const annotStart = scanUpwardForAnnotations(lines, declLine);
    let blockEnd: number;
    if (isIndentLanguage(lines, declLine)) {
      blockEnd = findIndentBlockEnd(lines, declLine);
    } else {
      blockEnd = findBraceBlockEnd(lines, findBraceStart(lines, declLine));
    }
    const startLine = Math.max(0, annotStart - contextLines);
    const endLine = Math.min(lines.length - 1, blockEnd + contextLines);
    const text = lines.slice(startLine, endLine + 1).join("\n");
    results.push({ file: filePath, symbol, startLine: startLine + 1, endLine: endLine + 1, text });
  }

  if (results.length === 1) return results[0]!;
  return { file: filePath, symbol, matches: results };
}

