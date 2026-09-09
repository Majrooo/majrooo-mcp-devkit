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
// src/skeleton.ts — generate a new module file with correct imports, declarations and visibility.
import fs from "fs";
import path from "path";
import { extractCodeBlock, escapeRegex } from "./symbols.js";
import { detectLanguage } from "./split.js";

export interface SkeletonOptions {
  language?: string;
  visibility?: string;
  dryRun?: boolean;
  overwrite?: boolean;
}

export interface SkeletonResult {
  dryRun: boolean;
  modulePath: string;
  language: string;
  content: string;
}

export interface SkeletonError {
  error: string;
  unknownSymbols?: string[];
}

function extractImports(sourceContent: string, lang: string): string[] {
  const lines = sourceContent.split(/\r?\n/);
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

/** Check if a line is a declaration OF the given symbol (not just a usage). */
function isDeclarationOf(line: string, symbol: string, lang: string): boolean {
  const esc = escapeRegex(symbol);
  if (lang === "rust") {
    // pub struct X / fn X / impl X / pub(crate) fn X etc.
    return new RegExp(`^(?:pub(?:\\s*\\([^)]*\\))?\\s+)?(?:fn|struct|enum|trait|type|const|static|impl|mod)\\s+${esc}\\b`).test(line)
      || new RegExp(`^impl\\s+${esc}\\b`).test(line);
  }
  if (lang === "typescript") {
    return new RegExp(`^(?:export\\s+)?(?:function|class|interface|type|const|enum|async\\s+function)\\s+${esc}\\b`).test(line);
  }
  if (lang === "python") {
    return new RegExp(`^(?:class|def|async\\s+def)\\s+${esc}\\b`).test(line);
  }
  if (lang === "cpp") {
    return new RegExp(`^(?:class|struct)\\s+${esc}\\b`).test(line);
  }
  return false;
}

export function generateModuleSkeleton(
  modulePath: string,
  symbols: string[],
  sourceFile: string,
  options: SkeletonOptions = {},
): SkeletonResult | SkeletonError {
  const { language, visibility, dryRun = true, overwrite = false } = options;
  const lang = language ?? detectLanguage(modulePath) ?? detectLanguage(sourceFile);
  if (!lang) return { error: `Cannot detect language for module: ${modulePath}` };

  let sourceContent: string;
  try { sourceContent = fs.readFileSync(sourceFile, "utf-8"); } catch {
    return { error: `Cannot read source file: ${sourceFile}` };
  }

  // Check overwrite
  if (!dryRun && !overwrite) {
    try { if (fs.existsSync(modulePath)) return { error: `File already exists (overwrite: false): ${modulePath}` }; } catch { /* ok */ }
  }

  // Validate all symbols exist
  const unknowns = symbols.filter((s) => {
    const result = extractCodeBlock(sourceFile, s);
    return "error" in result;
  });
  if (unknowns.length > 0) {
    return { error: `Symbols not found in sourceFile`, unknownSymbols: unknowns };
  }

  // Extract blocks — filter to declaration matches only (skip usage sites)
  const parts: string[] = [];
  for (const sym of symbols) {
    const result = extractCodeBlock(sourceFile, sym);
    if ("error" in result) continue;
    const allMatches = "matches" in result ? result.matches : [result];
    // Keep only matches where the symbol is actually declared
    const declMatches = allMatches.filter((m) => {
      const lines = m.text.split("\n");
      // Skip matches that originate from import/use statements
      const firstCodeLine = lines.find((l) => l.trim() !== "" && !/^\/\/|^\/\*|^\*|^#\[|^@|^"""/.test(l.trim()));
      if (firstCodeLine && /^(use|import|from)\s+/.test(firstCodeLine.trim())) return false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^\/\/|^\/\*|^\*|^#\[|^@|^"""/.test(trimmed)) continue;
        if (isDeclarationOf(trimmed, sym, lang)) return true;
      }
      return false;
    });
    const effective = declMatches.length > 0 ? declMatches : allMatches;
    for (const m of effective) parts.push(m.text);
  }

  // Build content
  const imports = extractImports(sourceContent, lang);
  const header = imports.length > 0 ? imports.join("\n") + "\n\n" : "";
  const body = parts.join("\n\n") + "\n";
  const content = header + body;

  const result: SkeletonResult = { dryRun, modulePath, language: lang, content };

  if (dryRun) return result;

  // Write
  try {
    const dir = path.dirname(modulePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(modulePath, content, "utf-8");
  } catch (err) {
    return { error: `Failed to write ${modulePath}: ${err}` };
  }

  return result;
}
