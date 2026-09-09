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
// src/tool-registry.ts — runtime registry for MCP tool metadata + Zod introspection.
import type { ZodObject, ZodType } from "zod";

export interface ToolParamInfo {
  name: string;
  type: string;
  required: boolean;
  default?: string | number | boolean;
  description: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  category: "command" | "refactoring" | "feedback";
  params: ToolParamInfo[];
}

const CATEGORY_MAP: Record<string, ToolInfo["category"]> = {
  run_safe_command: "command",
  run_destructive_command: "command",
  read_log_slice: "command",
  run_command_grep: "command",
  list_allowed_roots: "command",
  resolve_cwd: "command",
  universal_find_references: "refactoring",
  extract_code_block: "refactoring",
  split_file_by_declarations: "refactoring",
  batch_apply_edits: "refactoring",
  generate_module_skeleton: "refactoring",
  verify_refactor_safety: "refactoring",
  report_tool_feedback: "feedback",
  list_feedback: "feedback",
  close_feedback: "feedback",
  list_tools: "feedback",
  help_tool: "feedback",
};

const registry = new Map<string, ToolInfo>();

/** Minimal Zod type shape for introspection (avoids `any` casts). */
interface ZodDef {
  typeName?: string;
  type?: string;
  description?: string;
  defaultValue?: () => unknown;
}

interface ZodShape {
  _def?: ZodDef;
  description?: string;
}

/** Extract parameter info from a Zod object schema via introspection. */
function extractParams(schema: ZodObject, paramDescriptions?: Map<string, string>): ToolParamInfo[] {
  const shape = (schema as { shape?: Record<string, ZodShape> }).shape ?? {};
  const params: ToolParamInfo[] = [];
  for (const [key, zodType] of Object.entries(shape)) {
    const def: ZodDef | undefined = zodType._def;
    if (!def) continue;
    const typeName = def.typeName ?? def.type ?? "unknown";
    const isOptional = typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "optional";
    const description = paramDescriptions?.get(key) ?? zodType.description ?? def.description ?? "";
    let defaultVal: unknown;
    if (typeName === "ZodDefault" && def.defaultValue) {
      try { defaultVal = def.defaultValue(); } catch { /* ok */ }
    }
    params.push({
      name: key,
      type: isOptional ? "optional" : String(typeName).replace("Zod", "").toLowerCase(),
      required: !isOptional,
      default: defaultVal as string | number | boolean | undefined,
      description,
    });
  }
  return params;
}

/** Register a tool in the registry. */
export function registerToolInfo(
  name: string,
  description: string,
  schema: ZodObject,
  paramDescriptions?: Map<string, string>,
): void {
  const category = CATEGORY_MAP[name] ?? "refactoring";
  const params = extractParams(schema, paramDescriptions);
  registry.set(name, { name, description, category, params });
}

/** List all tools, optionally filtered by category. */
export function listToolInfos(category?: string): ToolInfo[] {
  const all = [...registry.values()];
  if (category) return all.filter((t) => t.category === category);
  return all;
}

/** Get detailed info for a specific tool. */
export function getToolInfo(name: string): ToolInfo | undefined {
  return registry.get(name);
}