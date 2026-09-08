import { describe, it, expect } from "vitest";
import { registerToolInfo, listToolInfos, getToolInfo } from "../tool-registry.js";
import { z } from "zod";

describe("tool-registry", () => {
  it("registerToolInfo stores tool and listToolInfos retrieves it", () => {
    const schema = z.object({
      name: z.string().describe("Your name"),
      age: z.number().optional().describe("Your age"),
    });
    registerToolInfo("test_tool_a", "A test tool for testing", schema);
    const tools = listToolInfos();
    expect(tools.some((t) => t.name === "test_tool_a")).toBe(true);
    const info = getToolInfo("test_tool_a");
    expect(info).toBeDefined();
    expect(info!.description).toBe("A test tool for testing");
    expect(info!.params.length).toBe(2);
  });

  it("listToolInfos filters by category", () => {
    // Register tools with names that have defined categories in CATEGORY_MAP
    const schema = z.object({});
    registerToolInfo("run_safe_command", "Execute safe command", schema);
    registerToolInfo("batch_apply_edits", "Apply edits", schema);
    const cmds = listToolInfos("command");
    expect(cmds.some((t) => t.name === "run_safe_command")).toBe(true);
    expect(cmds.some((t) => t.name === "batch_apply_edits")).toBe(false);
    const refs = listToolInfos("refactoring");
    expect(refs.some((t) => t.name === "batch_apply_edits")).toBe(true);
  });

  it("getToolInfo returns undefined for unknown tool", () => {
    expect(getToolInfo("nonexistent_tool_xyz")).toBeUndefined();
  });

  it("params include required and optional with descriptions", () => {
    const schema = z.object({
      file: z.string().describe("Source file"),
      cwd: z.string().optional().describe("Working dir"),
    });
    registerToolInfo("test_tool_b", "Test", schema);
    const info = getToolInfo("test_tool_b");
    expect(info).toBeDefined();
    const fileParam = info!.params.find((p) => p.name === "file");
    expect(fileParam).toBeDefined();
    expect(fileParam!.required).toBe(true);
    expect(fileParam!.description).toBe("Source file");
    const cwdParam = info!.params.find((p) => p.name === "cwd");
    expect(cwdParam).toBeDefined();
    expect(cwdParam!.required).toBe(false);
  });
});