import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { reportToolFeedback, readFeedbackEntries, closeFeedback, archiveClosedEntries } from "../feedback.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "feedback-test-"));
}
function cleanupDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
}

// ── helpers for the archive tests ───────────────────────────
const FEEDBACK_HEADER = "# MCP Tool Feedback Log\n<!-- project=proj server=srv v1.0.0 -->\n<!-- DO NOT EDIT manually -->\n";

/** Hand-written entry block — used to simulate entries that existed before archive support. */
function seedBlock(id: string, title: string, status: "open" | "closed"): string {
  return `## [BUG] ${title}\n> **id:** ${id}\n> **date:** 2026-01-01 10:00:00 UTC\n> **tool:** t\n> **type:** bug\n> **status:** ${status}\n\nSome description for ${title}`;
}

function writeFeedbackLog(dir: string, content: string) {
  fs.mkdirSync(path.join(dir, ".mcp"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mcp", "FEEDBACK.md"), content, "utf-8");
}

function readActiveLog(dir: string): string {
  return fs.readFileSync(path.join(dir, ".mcp", "FEEDBACK.md"), "utf-8");
}

function readArchiveLog(dir: string): string {
  return fs.readFileSync(path.join(dir, ".mcp", "FEEDBACK_ARCHIVE.md"), "utf-8");
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

  it("closeFeedback sets status to closed and moves the entry to the archive", () => {
    tmp = tmpDir();
    const r1 = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "Closeable bug", description: "fix me",
    });
    expect("error" in r1).toBe(false);
    if ("error" in r1 || !r1.written) return;
    const result = closeFeedback(tmp, r1.id);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.updated).toBe(true);
    expect(result.archived).toContain(r1.id);
    expect(result.archivePath).toContain("FEEDBACK_ARCHIVE.md");
    // Closed entry left the active log …
    expect(readFeedbackEntries(tmp)).toHaveLength(0);
    // … and is readable from the archive
    const archived = readFeedbackEntries(tmp, { archived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0]!.status).toBe("closed");
    expect(archived[0]!.id).toBe(r1.id);
  });

  it("closeFeedback adds resolution text (preserved in the archive)", () => {
    tmp = tmpDir();
    const r1 = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "Resolvable bug", description: "fix me",
    });
    if ("error" in r1 || !r1.written) return;
    closeFeedback(tmp, r1.id, "Fixed by adding imports");
    const entries = readFeedbackEntries(tmp, { archived: true });
    expect(entries[0]!.resolution).toBe("Fixed by adding imports");
  });

  it("closeFeedback on non-existent ID → error", () => {
    tmp = tmpDir();
    const result = closeFeedback(tmp, "nonexistent-id");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("not found");
  });

  it("closeFeedback on already closed → error (points at the archive)", () => {
    tmp = tmpDir();
    const r1 = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "Double close", description: "d",
    });
    if ("error" in r1 || !r1.written) return;
    closeFeedback(tmp, r1.id);
    const result = closeFeedback(tmp, r1.id);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("already closed");
      expect(result.error).toContain("FEEDBACK_ARCHIVE.md");
    }
  });

  it("closeFeedback: only the closed entry leaves the active log", () => {
    tmp = tmpDir();
    const r1 = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "Open one", description: "d",
    });
    reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "Still open", description: "d",
    });
    if ("error" in r1 || !r1.written) return;
    closeFeedback(tmp, r1.id);
    // Active log keeps the open entry only
    expect(readFeedbackEntries(tmp)).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { status: "open" })).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { status: "closed" })).toHaveLength(0);
    // Archive holds the closed one
    expect(readFeedbackEntries(tmp, { archived: true })).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { archived: true, status: "closed" })).toHaveLength(1);
  });
});

describe("feedback archive", () => {
  let tmp: string;
  afterEach(() => { if (tmp) { cleanupDir(tmp); tmp = ""; } });

  it("creates FEEDBACK_ARCHIVE.md with title + project header and keeps open entries", () => {
    tmp = tmpDir();
    // Entries closed before the archive feature existed
    writeFeedbackLog(tmp, `${FEEDBACK_HEADER}\n---\n${seedBlock("id-closed", "Old bug", "closed")}\n---\n${seedBlock("id-open", "Open bug", "open")}\n---\n`);
    const result = archiveClosedEntries(tmp);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.archived).toBe(1);
    expect(result.ids).toEqual(["id-closed"]);
    const archive = readArchiveLog(tmp);
    expect(archive).toContain("# MCP Tool Feedback Archive");
    expect(archive).toContain("<!-- project=proj server=srv v1.0.0 -->");
    expect(archive).toContain("> **id:** id-closed");
    expect(archive).not.toContain("id-open");
    // Open entry stays in the active log, header intact
    const active = readActiveLog(tmp);
    expect(active).toContain("> **id:** id-open");
    expect(active).not.toContain("id-closed");
    expect(active).toContain("<!-- project=proj server=srv v1.0.0 -->");
  });

  it("self-heals: entries closed before the feature existed migrate on the next close", () => {
    tmp = tmpDir();
    writeFeedbackLog(tmp, `${FEEDBACK_HEADER}\n---\n${seedBlock("id-legacy-1", "Legacy one", "closed")}\n---\n${seedBlock("id-legacy-2", "Legacy two", "closed")}\n---\n${seedBlock("id-open", "Open bug", "open")}\n---\n`);
    const r1 = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "Fresh bug", description: "d",
    });
    if ("error" in r1 || !r1.written) return;
    const result = closeFeedback(tmp, r1.id, "done");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.archived).toEqual(expect.arrayContaining(["id-legacy-1", "id-legacy-2", r1.id]));
    const archived = readFeedbackEntries(tmp, { archived: true });
    expect(archived.map((e) => e.id).sort()).toEqual(["id-legacy-1", "id-legacy-2", r1.id].sort());
    // Only the still-open entry remains in the active log
    expect(readFeedbackEntries(tmp).map((e) => e.id)).toEqual(["id-open"]);
  });

  it("keeps the active log tidy — one separator, header first, entries still parseable", () => {
    tmp = tmpDir();
    writeFeedbackLog(tmp, `${FEEDBACK_HEADER}\n---\n${seedBlock("id-closed", "Old bug", "closed")}\n---\n${seedBlock("id-open", "Open bug", "open")}\n---\n`);
    archiveClosedEntries(tmp);
    const active = readActiveLog(tmp);
    expect(active.startsWith("# MCP Tool Feedback Log\n")).toBe(true);
    expect(active).not.toContain("---\n---");
    expect(active.split("## [").length - 1).toBe(1);
    expect(readActiveLog(tmp)).toMatch(/\n---\n## \[BUG\] Open bug[\s\S]*\n---\n$/);
    expect(readFeedbackEntries(tmp).map((e) => e.id)).toEqual(["id-open"]);
    // Appending after the rewrite must not create a doubled separator either
    const r = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "New one", description: "d",
    });
    if ("error" in r || !r.written) return;
    expect(readActiveLog(tmp)).not.toContain("---\n---");
    expect(readFeedbackEntries(tmp)).toHaveLength(2);
  });

  it("is idempotent — archiving twice does not duplicate entries", () => {
    tmp = tmpDir();
    writeFeedbackLog(tmp, `${FEEDBACK_HEADER}\n---\n${seedBlock("id-closed", "Old bug", "closed")}\n---\n`);
    const first = archiveClosedEntries(tmp);
    expect("error" in first).toBe(false);
    const second = archiveClosedEntries(tmp);
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    expect(second.archived).toBe(0);
    expect(readArchiveLog(tmp).split("> **id:** id-closed").length - 1).toBe(1);
  });
});

describe("feedback archive — content preservation", () => {
  let tmp: string;
  afterEach(() => { if (tmp) { cleanupDir(tmp); tmp = ""; } });

  it("moves the block verbatim (title, description, reproduction, resolution, closedAt)", () => {
    tmp = tmpDir();
    const r1 = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "improvement", tool: "t", title: "Improve me", description: "long description here",
      reproduction: "step 1", expected: "better", suggestion: "do x",
    });
    if ("error" in r1 || !r1.written) return;
    closeFeedback(tmp, r1.id, "Resolved by x");
    const archive = readArchiveLog(tmp);
    expect(archive).toContain("[IMPROVEMENT] Improve me");
    expect(archive).toContain("long description here");
    expect(archive).toContain("**Reproduction:** step 1");
    expect(archive).toContain("**Expected:** better");
    expect(archive).toContain("**Suggestion:** do x");
    expect(archive).toContain("> **resolution:** Resolved by x");
    expect(archive).toContain("> **closedAt:**");
    expect(archive).toContain("> **status:** closed");
    expect(archive).toContain("> **tool:** t");
  });

  it("reports zero when there is nothing to archive, and errors when the log is missing", () => {
    tmp = tmpDir();
    const missing = archiveClosedEntries(tmp);
    expect("error" in missing).toBe(true);
    if ("error" in missing) expect(missing.error).toContain("not found");

    writeFeedbackLog(tmp, `${FEEDBACK_HEADER}\n---\n${seedBlock("id-open", "Open bug", "open")}\n---\n`);
    const empty = archiveClosedEntries(tmp);
    expect("error" in empty).toBe(false);
    if ("error" in empty) return;
    expect(empty.archived).toBe(0);
    expect(fs.existsSync(path.join(tmp, ".mcp", "FEEDBACK_ARCHIVE.md"))).toBe(false);
  });

  it("report_tool_feedback still appends to the active log after archiving", () => {
    tmp = tmpDir();
    writeFeedbackLog(tmp, `${FEEDBACK_HEADER}\n---\n${seedBlock("id-closed", "Old bug", "closed")}\n---\n`);
    archiveClosedEntries(tmp);
    const r = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "t", title: "After archive", description: "d",
    });
    expect("error" in r).toBe(false);
    if ("error" in r || !r.written) return;
    const active = readFeedbackEntries(tmp);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(r.id);
    expect(active[0]!.status).toBe("open");
    expect(readFeedbackEntries(tmp, { archived: true })).toHaveLength(1);
  });

  it("archived listing supports type / tool / status filters", () => {
    tmp = tmpDir();
    const a = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "bug", tool: "batch_apply_edits", title: "Bug A", description: "d",
    });
    const b = reportToolFeedback(tmp, "proj", "srv", "1.0.0", {
      type: "improvement", tool: "list_feedback", title: "Imp B", description: "d",
    });
    if ("error" in a || !a.written || "error" in b || !b.written) return;
    closeFeedback(tmp, a.id);
    closeFeedback(tmp, b.id);
    expect(readFeedbackEntries(tmp, { archived: true })).toHaveLength(2);
    expect(readFeedbackEntries(tmp, { archived: true, type: "improvement" })).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { archived: true, tool: "batch_apply_edits" })).toHaveLength(1);
    expect(readFeedbackEntries(tmp, { archived: true, status: "open" })).toHaveLength(0);
    expect(readFeedbackEntries(tmp, { archived: true, type: "bug" })[0]!.title).toBe("Bug A");
  });
});