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
};

const registry = new Map<string, ToolInfo>();

/** Extract parameter info from a Zod object schema via introspection. */
function extractParams(schema: ZodObject): ToolParamInfo[] {
  const shape = (schema as any).shape ?? {};
  const params: ToolParamInfo[] = [];
  for (const [key, zodType] of Object.entries<any>(shape)) {
    const def = zodType._def ?? zodType;
    const typeName = def.typeName ?? def.type ?? "unknown";
    const isOptional = typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "optional";
    const description = zodType.description ?? def.description ?? "";
    let defaultVal: string | number | boolean | undefined;
    if (typeName === "ZodDefault" && def.defaultValue) {
      try { defaultVal = def.defaultValue(); } catch { /* ok */ }
    }
    params.push({
      name: key,
      type: isOptional ? "optional" : String(typeName).replace("Zod", "").toLowerCase(),
      required: !isOptional,
      default: defaultVal,
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
): void {
  const category = CATEGORY_MAP[name] ?? "refactoring";
  const params = extractParams(schema);
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