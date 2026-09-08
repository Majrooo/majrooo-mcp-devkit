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
import { extractCodeBlock } from "./symbols.js";
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
  for (const line of lines) {
    const trimmed = line.trim();
    if (lang === "rust" && /^use\s+/.test(trimmed)) imports.push(line);
    else if (lang === "typescript" && /^import\s+/.test(trimmed)) imports.push(line);
    else if (lang === "python" && /^(import|from)\s+/.test(trimmed)) imports.push(line);
    else if (lang === "cpp" && /^#include\s+/.test(trimmed)) imports.push(line);
  }
  return imports;
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

  // Extract blocks
  const parts: string[] = [];
  for (const sym of symbols) {
    const result = extractCodeBlock(sourceFile, sym);
    if ("error" in result) continue;
    if ("matches" in result) {
      for (const m of result.matches) parts.push(m.text);
    } else {
      parts.push(result.text);
    }
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
