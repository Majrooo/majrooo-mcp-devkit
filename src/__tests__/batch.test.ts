import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { batchApplyEdits } from "../batch.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "batch-test-"));
}

function cleanupDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
}

function createTmpFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("batchApplyEdits", () => {
  let tmp: string;
  afterEach(() => { if (tmp) cleanupDir(tmp); tmp = ""; });

  it("dry-run returns preview without writing", () => {
    tmp = tmpDir();
    const f1 = createTmpFile(tmp, "a.ts", "export function foo() {}");
    const result = batchApplyEdits([
      { file: f1, search: "foo", replace: "bar" },
    ], { dryRun: true });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.dryRun).toBe(true);
    expect(result.validated).toBe(1);
    // File unchanged
    expect(fs.readFileSync(f1, "utf-8")).toBe("export function foo() {}");
  });

  it("applies multiple edits across files", () => {
    tmp = tmpDir();
    const f1 = createTmpFile(tmp, "a.ts", "const X = 1;");
    const f2 = createTmpFile(tmp, "b.ts", "const Y = 2;");
    const f3 = createTmpFile(tmp, "c.ts", "const Z = 3;");
    const result = batchApplyEdits([
      { file: f1, search: "X", replace: "A" },
      { file: f2, search: "Y", replace: "B" },
      { file: f3, search: "Z", replace: "C" },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    expect(fs.readFileSync(f1, "utf-8")).toBe("const A = 1;");
    expect(fs.readFileSync(f2, "utf-8")).toBe("const B = 2;");
    expect(fs.readFileSync(f3, "utf-8")).toBe("const C = 3;");
  });

  it("validation failure: search not found → error, zero files modified", () => {
    tmp = tmpDir();
    const f1 = createTmpFile(tmp, "a.ts", "const X = 1;");
    const result = batchApplyEdits([
      { file: f1, search: "NOTFOUND", replace: "Y" },
    ]);
    expect("error" in result).toBe(true);
    // File should NOT be modified
    expect(fs.readFileSync(f1, "utf-8")).toBe("const X = 1;");
  });

  it("duplicate match: search found 3 times + replaceAll: false → error", () => {
    tmp = tmpDir();
    const f1 = createTmpFile(tmp, "a.ts", "aaa bbb aaa ccc aaa");
    const result = batchApplyEdits([
      { file: f1, search: "aaa", replace: "zzz" },
    ]);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("3 times");
    // File unchanged
    expect(fs.readFileSync(f1, "utf-8")).toBe("aaa bbb aaa ccc aaa");
  });

  it("replaceAll: true replaces all occurrences", () => {
    tmp = tmpDir();
    const f1 = createTmpFile(tmp, "a.ts", "aaa bbb aaa ccc aaa");
    const result = batchApplyEdits([
      { file: f1, search: "aaa", replace: "zzz", replaceAll: true },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    expect(fs.readFileSync(f1, "utf-8")).toBe("zzz bbb zzz ccc zzz");
  });

  it("non-existent file returns error", () => {
    const result = batchApplyEdits([
      { file: "/nonexistent/file.ts", search: "x", replace: "y" },
    ]);
    expect("error" in result).toBe(true);
  });

  it("description field preserved in preview", () => {
    tmp = tmpDir();
    const f1 = createTmpFile(tmp, "a.ts", "hello world");
    const result = batchApplyEdits([
      { file: f1, search: "hello", replace: "bye", description: "Greet change" },
    ]);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.preview[0]!.description).toBe("Greet change");
  });

  it("multiple edits to same file accumulate correctly", () => {
    tmp = tmpDir();
    const f = createTmpFile(tmp, "multi.txt", "aaa bbb ccc");
    const result = batchApplyEdits([
      { file: f, search: "aaa", replace: "AAA" },
      { file: f, search: "bbb", replace: "BBB" },
      { file: f, search: "ccc", replace: "CCC" },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(fs.readFileSync(f, "utf-8")).toBe("AAA BBB CCC");
  });

  it("CRLF line endings are handled correctly", () => {
    tmp = tmpDir();
    const f = createTmpFile(tmp, "crlf.txt", "line1\r\nline2\r\nline3");
    const result = batchApplyEdits([
      { file: f, search: "line2", replace: "LINE2" },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(f, "utf-8");
    expect(content).toContain("LINE2");
    expect(content).toContain("\r\n"); // preserve CRLF
    expect(content).not.toContain("line2");
  });

  it("CRLF: multi-line search string matches", () => {
    tmp = tmpDir();
    const f = createTmpFile(tmp, "crlf2.txt", "aaa\r\nbbb\r\nccc");
    const result = batchApplyEdits([
      { file: f, search: "aaa\nbbb", replace: "AAA\nBBB" },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(f, "utf-8");
    expect(content).toContain("AAA");
    expect(content).toContain("BBB");
  });

  // ── Sequential application (bug fix) ──────────────────────

  it("sequential edits: edit 2 depends on edit 1's replacement", () => {
    tmp = tmpDir();
    const f = createTmpFile(tmp, "chain.rs", "const MATERIALS: usize = 3;\nlet x = MATERIALS;");
    // Edit 1: rename MATERIALS → DEFAULT_MATERIALS (replaceAll since it appears twice)
    // Edit 2: update usage of DEFAULT_MATERIALS (searches for the NEW name)
    const result = batchApplyEdits([
      { file: f, search: "MATERIALS", replace: "DEFAULT_MATERIALS", replaceAll: true },
      { file: f, search: "DEFAULT_MATERIALS", replace: "MATERIAL_COUNT", replaceAll: true },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(f, "utf-8");
    expect(content).toContain("MATERIAL_COUNT");
    expect(content).not.toContain("MATERIALS");
    expect(content).not.toContain("DEFAULT_MATERIALS");
  });

  it("sequential edits: rollback on failure after partial apply", () => {
    tmp = tmpDir();
    const f = createTmpFile(tmp, "rollback.rs", "aaa bbb ccc");
    // Edit 1: aaa → AAA (will succeed)
    // Edit 2: NOTEXIST → X (will fail)
    const result = batchApplyEdits([
      { file: f, search: "aaa", replace: "AAA" },
      { file: f, search: "NOTEXIST", replace: "X" },
    ], { dryRun: false });
    expect("error" in result).toBe(true);
    // File should be rolled back to original
    expect(fs.readFileSync(f, "utf-8")).toBe("aaa bbb ccc");
  });

  it("sequential edits: dry-run validates against original (may differ from apply)", () => {
    tmp = tmpDir();
    const f = createTmpFile(tmp, "drychain.rs", "const MATERIALS: usize = 3;\nlet x = MATERIALS;");
    // Dry-run validates all against original — edit 2 searches for DEFAULT_MATERIALS
    // which doesn't exist in original, so dry-run reports error for edit 2.
    const dryResult = batchApplyEdits([
      { file: f, search: "MATERIALS", replace: "DEFAULT_MATERIALS", replaceAll: true },
      { file: f, search: "DEFAULT_MATERIALS", replace: "MATERIAL_COUNT", replaceAll: true },
    ], { dryRun: true });
    // Dry-run defers validation for edit 2 (chained on same file)
    expect("dryRun" in dryResult && dryResult.dryRun).toBe(true);
  });

  // ── excludePatterns (bug fix) ────────────────────────────

  it("replaceAll with excludePatterns skips excluded regions", () => {
    tmp = tmpDir();
    const rustCode = [
      "pub fn do_work() {",
      "    let hold_state = State::new();",
      "    hold_state.update();",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "    #[test]",
      "    fn test_hold_state() {",
      "        let hold_state = State::default();",
      "        hold_state.validate();",
      "    }",
      "}",
    ].join("\n");
    const f = createTmpFile(tmp, "test.rs", rustCode);
    const result = batchApplyEdits([
      {
        file: f,
        search: "hold_state",
        replace: "hold_follow.hold",
        replaceAll: true,
        excludePatterns: ["#[cfg(test)]"],
      },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(f, "utf-8");
    // Function body should be updated
    expect(content).toContain("hold_follow.hold.update();");
    // Test module should be untouched
    expect(content).toContain("let hold_state = State::default();");
    expect(content).toContain("hold_state.validate();");
  });

  it("replaceAll without excludePatterns replaces everything", () => {
    tmp = tmpDir();
    const code = "let hold_state = 1;\nhold_state.update();\n// hold_state in comment";
    const f = createTmpFile(tmp, "noexclude.rs", code);
    const result = batchApplyEdits([
      { file: f, search: "hold_state", replace: "x", replaceAll: true },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(f, "utf-8");
    expect(content).not.toContain("hold_state");
    expect(content).toContain("let x = 1;");
  });

  it("excludePatterns with #[test] annotation skips single-line blocks", () => {
    tmp = tmpDir();
    const code = "const FOO: i32 = 42;\n#[test]\nfn test_foo() { assert_eq!(FOO, 42); }";
    const f = createTmpFile(tmp, "annot.rs", code);
    const result = batchApplyEdits([
      {
        file: f,
        search: "FOO",
        replace: "BAR",
        replaceAll: true,
        excludePatterns: ["#[test]"],
      },
    ], { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(f, "utf-8");
    // Top-level const should be updated
    expect(content).toContain("const BAR: i32 = 42;");
    // Test function should be untouched
    expect(content).toContain("assert_eq!(FOO, 42);");
  });

  // ── partial rollback (bug fix) ────────────────────────────

  it("partial rollback: preserves edits on earlier files when later chained edit fails", () => {
    tmp = tmpDir();
    const f1 = createTmpFile(tmp, "a.ts", "const X = 1;");
    const f2 = createTmpFile(tmp, "b.ts", "const Y = 2;");
    // Edit 1 on f1 (succeeds), Edit 2 on f2 (succeeds),
    // Edit 3 on f1 chained (Phase 1 deferred, Phase 2 fails — NOTEXIST after X was replaced)
    const result = batchApplyEdits([
      { file: f1, search: "X", replace: "A" },
      { file: f2, search: "Y", replace: "B" },
      { file: f1, search: "NOTEXIST", replace: "C" },
    ], { dryRun: false });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.failedAt).toBe(2);
    // f1 was modified by edit 0 but rolled back by edit 2 failure (same file)
    expect(fs.readFileSync(f1, "utf-8")).toBe("const X = 1;");
    // f2 (edited before failure on a different file) should be preserved
    expect(fs.readFileSync(f2, "utf-8")).toBe("const B = 2;");
  });

  it("partial rollback: preserves multiple earlier file edits", () => {
    tmp = tmpDir();
    const f1 = createTmpFile(tmp, "x.ts", "aaa");
    const f2 = createTmpFile(tmp, "y.ts", "bbb");
    const f4 = createTmpFile(tmp, "w.ts", "ddd");
    // Edit 1 on f1 (succeeds), Edit 2 on f2 (succeeds),
    // Edit 3 on f1 chained (deferred, fails), Edit 4 on f4 (not reached)
    const result = batchApplyEdits([
      { file: f1, search: "aaa", replace: "AAA" },
      { file: f2, search: "bbb", replace: "BBB" },
      { file: f1, search: "NOTEXIST", replace: "CCC" },
      { file: f4, search: "ddd", replace: "DDD" },
    ], { dryRun: false });
    expect("error" in result).toBe(true);
    // f1 reverted (failed chain on same file)
    expect(fs.readFileSync(f1, "utf-8")).toBe("aaa");
    // f2 preserved (different file, edited before failure)
    expect(fs.readFileSync(f2, "utf-8")).toBe("BBB");
    // f4 reverted (edit not yet applied, rollback reverts to original)
    expect(fs.readFileSync(f4, "utf-8")).toBe("ddd");
  });

  it("partial rollback: same-file chain failure reverts entire file", () => {
    tmp = tmpDir();
    const f = createTmpFile(tmp, "chain.rs", "const MATERIALS: usize = 3;");
    const result = batchApplyEdits([
      { file: f, search: "MATERIALS", replace: "DEFAULT_MATERIALS" },
      { file: f, search: "NOTEXIST", replace: "X" },
    ], { dryRun: false });
    expect("error" in result).toBe(true);
    // Same file: entire file is rolled back (can't partially undo a single file)
    expect(fs.readFileSync(f, "utf-8")).toBe("const MATERIALS: usize = 3;");
  });

  it("partial rollback: all edits on same file — rollback entire file on failure", () => {
    tmp = tmpDir();
    const f = createTmpFile(tmp, "single.ts", "const A = 1; const B = 2;");
    const result = batchApplyEdits([
      { file: f, search: "A", replace: "X" },
      { file: f, search: "NOTFOUND", replace: "Y" },
    ], { dryRun: false });
    expect("error" in result).toBe(true);
    // Both edits were on same file, entire file rolled back
    expect(fs.readFileSync(f, "utf-8")).toBe("const A = 1; const B = 2;");
  });
});