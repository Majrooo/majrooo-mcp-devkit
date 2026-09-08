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
// src/verify.ts — semantic diff between old and new code. Catches accidental deletions.

interface LangPatterns {
  declaration: RegExp;
  exportDecl: RegExp;
  importLine: RegExp;
}

const LANG_PATTERNS: Record<string, LangPatterns> = {
  rust: {
    declaration: /^(pub\s+)?(fn|struct|enum|trait|type|const|static)\s+(\w+)/,
    exportDecl: /^pub\s+(fn|struct|enum|trait|type|const|static)\s+(\w+)/,
    importLine: /^\s*use\s+/,
  },
  typescript: {
    declaration: /^(export\s+)?(function|class|interface|type|const|enum|async\s+function)\s+(\w+)/,
    exportDecl: /^export\s+(function|class|interface|type|const|enum|async\s+function)\s+(\w+)/,
    importLine: /^\s*import\s+/,
  },
  python: {
    declaration: /^(class|def|async\s+def)\s+(\w+)/,
    exportDecl: /^(class|def|async\s+def)\s+(\w+)/,
    importLine: /^\s*(import|from)\s+/,
  },
  cpp: {
    declaration: /^(class|struct)\s+(\w+)/,
    exportDecl: /^(class|struct)\s+(\w+)/,
    importLine: /^\s*#include\s+/,
  },
};

function detectLanguageFromContent(code: string): string | undefined {
  if (/^\s*(use\s+\w|pub\s+(fn|struct|enum|trait))\s/m.test(code)) return "rust";
  if (/^\s*(import|from)\s+\w/m.test(code) && /:\s*\w/.test(code)) return "python";
  if (/^\s*#include\s/m.test(code)) return "cpp";
  if (/^\s*(import\s+\{|import\s+\w+\s+from|export\s+(function|class|interface))/m.test(code)) return "typescript";
  return undefined;
}

// ── Types ───────────────────────────────────────────────────

export type CheckStatus = "error" | "warning" | "info";

export interface CheckResult {
  check: string;
  status: CheckStatus;
  detail: string;
  before?: number;
  after?: number;
}

export interface VerifyResult {
  safe: boolean;
  checks: CheckResult[];
  summary: {
    functionsBefore: number;
    functionsAfter: number;
    exportsBefore: number;
    exportsAfter: number;
    linesBefore: number;
    linesAfter: number;
  };
}

export interface VerifyOptions { language?: string; }

// ── Helpers ─────────────────────────────────────────────────

interface SymbolInfo { name: string; signature: string; isExport: boolean; }

function normalizeSignature(line: string): string {
  return line.replace(/\s+/g, " ").replace(/\s*([{}(,;])\s*/g, "$1").trim();
}

function extractSymbols(code: string, lang: string): SymbolInfo[] {
  const p = LANG_PATTERNS[lang];
  if (!p) return [];
  const symbols: SymbolInfo[] = [];
  for (const line of code.split(/\r?\n/)) {
    const trimmed = line.trim();
    const m = p.declaration.exec(trimmed);
    if (!m) continue;
    let name: string; let isExport: boolean;
    if (lang === "rust") { name = m[3]!; isExport = /pub\s+/.test(trimmed); }
    else if (lang === "typescript") { name = m[3]!; isExport = /^export\s+/.test(trimmed); }
    else { name = m[2]!; isExport = p.exportDecl.test(trimmed); }
    symbols.push({ name, signature: normalizeSignature(trimmed), isExport });
  }
  return symbols;
}

function extractImports(code: string, lang: string): string[] {
  const p = LANG_PATTERNS[lang];
  if (!p) return [];
  return code.split(/\r?\n/).filter((l) => p.importLine.test(l.trim())).map((l) => l.trim());
}

function countCommentLines(code: string): number {
  let count = 0; let inBlock = false;
  for (const line of code.split(/\r?\n/)) {
    const t = line.trim();
    if (inBlock) { count++; if (t.includes("*/")) inBlock = false; continue; }
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("/*")) {
      count++;
      if (t.startsWith("/*") && !t.includes("*/")) inBlock = true;
    }
  }
  return count;
}

function countCodeLines(code: string): number {
  let count = 0; let inBlock = false;
  for (const line of code.split(/\r?\n/)) {
    const t = line.trim();
    if (inBlock) { if (t.includes("*/")) inBlock = false; continue; }
    if (t === "" || t.startsWith("//") || t.startsWith("#")) continue;
    if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; continue; }
    count++;
  }
  return count;
}

// ── Main function ───────────────────────────────────────────

export function verifyRefactorSafety(
  before: string,
  after: string,
  options: VerifyOptions = {},
): VerifyResult {
  const lang = options.language ?? detectLanguageFromContent(before) ?? detectLanguageFromContent(after) ?? "typescript";
  const checks: CheckResult[] = [];

  const beforeSymbols = extractSymbols(before, lang);
  const afterSymbols = extractSymbols(after, lang);
  const beforeNames = new Set(beforeSymbols.map((s) => s.name));
  const afterNames = new Set(afterSymbols.map((s) => s.name));

  // Check 1: Function count
  const missing = [...beforeNames].filter((n) => !afterNames.has(n));
  const added = [...afterNames].filter((n) => !beforeNames.has(n));
  checks.push({
    check: "function_count",
    status: missing.length > 0 ? "error" : "info",
    before: beforeSymbols.length,
    after: afterSymbols.length,
    detail: missing.length > 0
      ? `Missing symbols: ${missing.join(", ")}`
      : added.length > 0 ? `${added.length} new symbols added` : "All symbols preserved",
  });

  // Check 2: Function signatures
  const beforeMap = new Map(beforeSymbols.map((s) => [s.name, s]));
  const afterMap = new Map(afterSymbols.map((s) => [s.name, s]));
  const changed: string[] = [];
  for (const name of beforeNames) {
    if (!afterNames.has(name)) continue;
    if (beforeMap.get(name)!.signature !== afterMap.get(name)!.signature) changed.push(name);
  }
  checks.push({
    check: "function_signatures",
    status: changed.length > 0 ? "error" : "info",
    detail: changed.length > 0 ? `Signatures changed: ${changed.join(", ")}` : "All signatures unchanged",
  });

  // Check 3: Export count
  const beforeExports = beforeSymbols.filter((s) => s.isExport).length;
  const afterExports = afterSymbols.filter((s) => s.isExport).length;
  checks.push({
    check: "export_count",
    status: beforeExports !== afterExports ? "warning" : "info",
    before: beforeExports,
    after: afterExports,
    detail: beforeExports !== afterExports
      ? `Export count changed: ${beforeExports} → ${afterExports}`
      : `Export count unchanged (${beforeExports})`,
  });

  // Check 4: Import changes
  const beforeImports = extractImports(before, lang);
  const afterImports = extractImports(after, lang);
  const newImp = afterImports.filter((i) => !beforeImports.includes(i));
  const remImp = beforeImports.filter((i) => !afterImports.includes(i));
  if (newImp.length > 0 || remImp.length > 0) {
    checks.push({
      check: "import_changes",
      status: "info",
      detail: `${newImp.length} new imports, ${remImp.length} removed imports (expected for module split)`,
    });
  }

  // Check 5: Comment ratio (>30% decrease → warning)
  const bComments = countCommentLines(before);
  const aComments = countCommentLines(after);
  const bCode = countCodeLines(before);
  const aCode = countCodeLines(after);
  if (bCode > 0 && aCode > 0) {
    const bRatio = bComments / bCode;
    const aRatio = aComments / aCode;
    if (bRatio > 0 && aRatio < bRatio * 0.7) {
      checks.push({
        check: "comment_ratio",
        status: "warning",
        detail: `Comment ratio decreased by >30%: ${(bRatio * 100).toFixed(1)}% → ${(aRatio * 100).toFixed(1)}%`,
      });
    }
  }

  return {
    safe: !checks.some((c) => c.status === "error"),
    checks,
    summary: {
      functionsBefore: beforeSymbols.length,
      functionsAfter: afterSymbols.length,
      exportsBefore: beforeExports,
      exportsAfter: afterExports,
      linesBefore: before.split(/\r?\n/).length,
      linesAfter: after.split(/\r?\n/).length,
    },
  };
}
