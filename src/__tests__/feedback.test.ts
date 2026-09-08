import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { reportToolFeedback, readFeedbackEntries } from "../feedback.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "feedback-test-"));
}
function cleanupDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
}

describe("reportToolFeedback", () => {
  let tmp: string;
  afterEach(() => { if (tmp) { cleanupDir(tmp); tmp = ""; } });

  it("creates .mcp/FEEDBACK.md with header on first write", () => {
    tmp = tmpDir();
    const result = reportToolFeedback(tmp, "test-project", "test-server", "1.0.0", {
      type: "bug",
      tool: "my_tool",
      title: "Something is broken",
      description: "It does not work correctly.",
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.written).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(true);
    const content = fs.readFileSync(result.filePath, "utf-8");
    expect(content).toContain("<!-- project=test-project server=test-server v1.0.0 -->");
    expect(content).toContain("[BUG] Something is broken");
    expect(content).toContain("**tool:** my_tool");
  });

  it("appends entry to existing file", () => {
    tmp = tmpDir();
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t1", title: "First issue", description: "desc1",
    });
    const result = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "improvement", tool: "t2", title: "Second issue", description: "desc2",
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.written).toBe(true);
    const content = fs.readFileSync(result.filePath, "utf-8");
    expect(content).toContain("[BUG] First issue");
    expect(content).toContain("[IMPROVEMENT] Second issue");
  });

  it("duplicate ID → skipped", () => {
    tmp = tmpDir();
    const input = { type: "bug" as const, tool: "t1", title: "Same title", description: "desc" };
    const r1 = reportToolFeedback(tmp, "proj", "srv", "1.0.0", input);
    const r2 = reportToolFeedback(tmp, "proj", "srv", "1.0.0", input);
    expect("error" in r1).toBe(false);
    expect("error" in r2).toBe(false);
    if ("error" in r2) return;
    expect(r2.written).toBe(false);
    expect(r2.reason).toBe("duplicate");
  });

  it("foreign header → error", () => {
    tmp = tmpDir();
    const dir = path.join(tmp, ".mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "FEEDBACK.md"),
      "# MCP Tool Feedback Log\n<!-- project=other-project server=x v1.0.0 -->\n", "utf-8");
    const result = reportToolFeedback(tmp, "my-project", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "test", description: "desc",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("no valid header");
  });

  it("all type values accepted", () => {
    tmp = tmpDir();
    for (const type of ["bug", "improvement", "feature_request"] as const) {
      const r = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
        type, tool: "t", title: `type-${type}`, description: "desc",
      });
      expect("error" in r).toBe(false);
    }
    const content = fs.readFileSync(path.join(tmp, ".mcp", "FEEDBACK.md"), "utf-8");
    expect(content).toContain("[BUG]");
    expect(content).toContain("[IMPROVEMENT]");
    expect(content).toContain("[FEATURE REQUEST]");
  });

  it("readFeedbackEntries parses entries correctly", () => {
    tmp = tmpDir();
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t1", title: "Bug one", description: "Bug description",
    });
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "feature_request", tool: "t2", title: "Feature two", description: "Feature description",
    });
    const entries = readFeedbackEntries(tmp);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.type).toBe("bug");
    expect(entries[0]!.title).toBe("Bug one");
    expect(entries[1]!.type).toBe("feature_request");
  });

  it("empty directory → readFeedbackEntries returns empty", () => {
    tmp = tmpDir();
    expect(readFeedbackEntries(tmp)).toHaveLength(0);
  });

  it("filter by type", () => {
    tmp = tmpDir();
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", { type: "bug", tool: "t1", title: "Bug one", description: "d" });
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", { type: "improvement", tool: "t2", title: "Improve one", description: "d" });
    expect(readFeedbackEntries(tmp, { type: "bug" })).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { type: "improvement" })).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { type: "feature_request" })).toHaveLength(0);
  });

  it("filter by tool", () => {
    tmp = tmpDir();
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", { type: "bug", tool: "alpha", title: "Alpha bug", description: "d" });
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", { type: "bug", tool: "beta", title: "Beta bug", description: "d" });
    expect(readFeedbackEntries(tmp, { tool: "alpha" })).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { tool: "beta" })).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { tool: "gamma" })).toHaveLength(0);
  });

  it("reproduction/expected/suggestion fields included", () => {
    tmp = tmpDir();
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "with details", description: "desc",
      reproduction: "step 1, step 2", expected: "should work", suggestion: "fix it",
    });
    const content = fs.readFileSync(path.join(tmp, ".mcp", "FEEDBACK.md"), "utf-8");
    expect(content).toContain("**Reproduction:** step 1, step 2");
    expect(content).toContain("**Expected:** should work");
    expect(content).toContain("**Suggestion:** fix it");
  });
});