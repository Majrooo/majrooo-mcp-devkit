import { describe, it, expect } from "vitest";
import { textResult, jsonResult } from "../format.js";

// ── Tool handler output format tests ─────────────────────
// These tests verify that tool handlers produce the correct text format.
// They test the formatting functions directly (not the full handler pipeline)
// to catch regressions in output shape without mocking the entire MCP server.

describe("tool output format — universal_find_references", () => {
  it("formats single-file matches as readable text", () => {
    const out: string[] = ["Symbol: myFunc", "Total matches: 2", ""];
    out.push("src/main.ts:");
    out.push("  Line 10:5 — const x = myFunc();");
    out.push("  Line 25:1 — function myFunc() {");
    out.push("");

    const result = textResult(out.join("\n"));
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Symbol: myFunc");
    expect(text).toContain("Total matches: 2");
    expect(text).toContain("Line 10:5");
  });

  it("formats no-matches result", () => {
    const result = textResult("Symbol: unknown\nTotal matches: 0\n\n(no matches found)");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("(no matches found)");
  });
});

describe("tool output format — batch_apply_edits", () => {
  it("formats dry-run preview as JSON", () => {
    const data = { edits: 3, dryRun: true, results: [{ file: "a.ts", found: true }] };
    const result = jsonResult(data);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.edits).toBe(3);
    expect(parsed.dryRun).toBe(true);
  });
});

describe("tool output format — list_feedback", () => {
  it("formats feedback list as JSON with entries", () => {
    const data = {
      total: 2,
      entries: [
        { id: "abc", type: "bug", title: "Test issue", status: "open" },
        { id: "def", type: "improvement", title: "Another", status: "closed" },
      ],
    };
    const result = jsonResult(data);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.entries).toHaveLength(2);
  });
});

describe("tool output format — error cases", () => {
  it("error result contains isError flag", () => {
    const result = {
      ...textResult("**Error:** Unknown tool: `foo`"),
      isError: true,
    };
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Unknown tool");
    expect(text).toContain("foo");
  });

  it("error result for cwd resolution failure", () => {
    const result = textResult("**Error:** Path not in allowed roots");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Error");
    expect(text).toContain("allowed roots");
  });
});