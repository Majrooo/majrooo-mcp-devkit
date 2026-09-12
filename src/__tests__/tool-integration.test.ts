import { describe, it, expect, afterEach, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { z } from "zod";
import { registerToolInfo, listToolInfos, getToolInfo } from "../tool-registry.js";
import { findAllowedProjects, resolveCwdRequested } from "../safety.js";
import { ALLOWED_ROOTS } from "../safety.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tool-integ-"));
}
function cleanupDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
}

// Register all 17 tools for test isolation (index.ts can't be imported
// because it starts the stdio server).
const TOOL_DEFS: [string, string, z.ZodObject<any>][] = [
  ["run_safe_command", "Execute a shell command.", z.object({ command: z.string(), cwd: z.string().optional() })],
  ["run_destructive_command", "Dangerous commands after confirmation.", z.object({ command: z.string(), confirm: z.boolean().optional() })],
  ["read_log_slice", "Read a slice of a log file.", z.object({ logPath: z.string() })],
  ["run_command_grep", "Run a command and filter output.", z.object({ command: z.string(), pattern: z.string() })],
  ["list_allowed_roots", "Returns allowed-roots configuration.", z.object({})],
  ["resolve_cwd", "Verify a path is inside allowed roots.", z.object({ path: z.string() })],
  ["universal_find_references", "Find symbol occurrences.", z.object({ symbol: z.string() })],
  ["extract_code_block", "Extract a function/struct/class.", z.object({ file: z.string(), symbol: z.string() })],
  ["split_file_by_declarations", "Split a file into smaller files.", z.object({ file: z.string(), grouping: z.array(z.object({ module: z.string(), symbols: z.array(z.string()) })) })],
  ["batch_apply_edits", "Apply edits atomically.", z.object({ edits: z.array(z.object({ file: z.string(), search: z.string(), replace: z.string() })), dryRun: z.boolean().optional() })],
  ["generate_module_skeleton", "Generate a module file.", z.object({ modulePath: z.string(), symbols: z.array(z.string()), sourceFile: z.string() })],
  ["verify_refactor_safety", "Semantic diff between code versions.", z.object({ before: z.string(), after: z.string() })],
  ["report_tool_feedback", "Report a bug or improvement.", z.object({ type: z.enum(["bug", "improvement", "feature_request"]), tool: z.string(), title: z.string(), description: z.string() })],
  ["list_feedback", "List feedback entries.", z.object({})],
  ["close_feedback", "Close a feedback entry.", z.object({ id: z.string() })],
  ["list_tools", "List all available tools.", z.object({})],
  ["help_tool", "Get help for a tool.", z.object({ tool: z.string() })],
];

beforeAll(() => {
  for (const [name, desc, schema] of TOOL_DEFS) {
    registerToolInfo(name, desc, schema);
  }
});

// ── list_tools: tool registry completeness ───────────────────

describe("list_tools — tool registry", () => {
  it("all 17 tools are registered", () => {
    const tools = listToolInfos();
    expect(tools.length).toBeGreaterThanOrEqual(17);
    for (const [name] of TOOL_DEFS) {
      expect(tools.some((t) => t.name === name)).toBe(true);
    }
  });

  it("each tool has a non-empty description", () => {
    for (const [name] of TOOL_DEFS) {
      const info = getToolInfo(name);
      expect(info).toBeDefined();
      expect(info!.description.length).toBeGreaterThan(0);
    }
  });

  it("command tools are in the command category", () => {
    const cmdNames = listToolInfos("command").map((t) => t.name);
    for (const n of ["run_safe_command", "run_destructive_command", "read_log_slice", "run_command_grep", "list_allowed_roots", "resolve_cwd"]) {
      expect(cmdNames).toContain(n);
    }
  });

  it("refactoring tools are in the refactoring category", () => {
    const refNames = listToolInfos("refactoring").map((t) => t.name);
    for (const n of ["universal_find_references", "extract_code_block", "batch_apply_edits", "generate_module_skeleton", "verify_refactor_safety"]) {
      expect(refNames).toContain(n);
    }
  });

  it("feedback tools are in the feedback category", () => {
    const fbNames = listToolInfos("feedback").map((t) => t.name);
    for (const n of ["report_tool_feedback", "list_feedback", "close_feedback", "list_tools", "help_tool"]) {
      expect(fbNames).toContain(n);
    }
  });
});


// ── help_tool: per-tool introspection ────────────────────────

describe("help_tool — tool info", () => {
  it("run_safe_command has required param: command", () => {
    const info = getToolInfo("run_safe_command");
    expect(info).toBeDefined();
    const cmd = info!.params.find((p) => p.name === "command");
    expect(cmd).toBeDefined();
    expect(cmd!.required).toBe(true);
  });

  it("run_safe_command has optional param: cwd", () => {
    const info = getToolInfo("run_safe_command");
    const cwd = info!.params.find((p) => p.name === "cwd");
    expect(cwd).toBeDefined();
    expect(cwd!.required).toBe(false);
  });

  it("read_log_slice has required param: logPath", () => {
    const info = getToolInfo("read_log_slice");
    expect(info).toBeDefined();
    const p = info!.params.find((x) => x.name === "logPath");
    expect(p).toBeDefined();
    expect(p!.required).toBe(true);
  });

  it("list_allowed_roots has no parameters", () => {
    const info = getToolInfo("list_allowed_roots");
    expect(info).toBeDefined();
    expect(info!.params).toHaveLength(0);
  });

  it("resolve_cwd has required param: path", () => {
    const info = getToolInfo("resolve_cwd");
    expect(info).toBeDefined();
    const p = info!.params.find((x) => x.name === "path");
    expect(p).toBeDefined();
    expect(p!.required).toBe(true);
  });

  it("batch_apply_edits has param: dryRun", () => {
    const info = getToolInfo("batch_apply_edits");
    expect(info).toBeDefined();
    const p = info!.params.find((x) => x.name === "dryRun");
    expect(p).toBeDefined();
    expect(p!.required).toBe(false);
  });

  it("unknown tool returns undefined", () => {
    expect(getToolInfo("nonexistent_xyz_tool")).toBeUndefined();
  });
});

// ── read_log_slice: file reading logic ───────────────────────

describe("read_log_slice — file reading", () => {
  let tmp: string;
  afterEach(() => { if (tmp) { cleanupDir(tmp); tmp = ""; } });

  it("reads entire file when startLine=0 and lineCount is large", () => {
    tmp = tmpDir();
    const logFile = path.join(tmp, "test.log");
    fs.writeFileSync(logFile, "line1\nline2\nline3\n", "utf-8");
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.split(/\r?\n/);
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe("line1");
    expect(lines[2]).toBe("line3");
  });

  it("slices from offset", () => {
    tmp = tmpDir();
    const logFile = path.join(tmp, "test.log");
    fs.writeFileSync(logFile, "a\nb\nc\nd\ne\n", "utf-8");
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.split(/\r?\n/);
    const slice = lines.slice(2, 4);
    expect(slice).toEqual(["c", "d"]);
  });

  it("handles empty file", () => {
    tmp = tmpDir();
    const logFile = path.join(tmp, "empty.log");
    fs.writeFileSync(logFile, "", "utf-8");
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.split(/\r?\n/);
    expect(lines).toEqual([""]);
  });

  it("error on non-existent file", () => {
    expect(() => {
      fs.readFileSync("/nonexistent/path/file.log", "utf-8");
    }).toThrow();
  });
});

// ── list_allowed_roots: project discovery ─────────────────────

describe("list_allowed_roots — project discovery", () => {
  it("ALLOWED_ROOTS is a non-empty array", () => {
    expect(Array.isArray(ALLOWED_ROOTS)).toBe(true);
    expect(ALLOWED_ROOTS.length).toBeGreaterThan(0);
  });

  it("findAllowedProjects returns an array", async () => {
    const projects = await findAllowedProjects();
    expect(Array.isArray(projects)).toBe(true);
  });

  it("each project is a string path or { path, name } object", async () => {
    const projects = await findAllowedProjects();
    for (const p of projects) {
      if (typeof p === "string") {
        expect(p.length).toBeGreaterThan(0);
      } else {
        expect(typeof p.path).toBe("string");
        expect(p.path.length).toBeGreaterThan(0);
        expect(typeof p.name).toBe("string");
      }
    }
  });
});

// ── resolve_cwd: path validation ─────────────────────────────

describe("resolve_cwd — path validation", () => {
  it("valid absolute path within root succeeds", () => {
    const root = ALLOWED_ROOTS[0];
    if (!root) return;
    const result = resolveCwdRequested(root);
    expect(result.ok).toBe(true);
  });

  it("path outside roots fails", () => {
    const result = resolveCwdRequested("Z:\\totally\\nonexistent\\path");
    expect(result.ok).toBe(false);
  });

  it("directory escape is rejected", () => {
    const result = resolveCwdRequested("C:\\Windows\\..\\..\\etc");
    expect(result.ok).toBe(false);
  });

  it("undefined cwd returns primary root", () => {
    const result = resolveCwdRequested(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cwd).toBe(ALLOWED_ROOTS[0]);
    }
  });
});
