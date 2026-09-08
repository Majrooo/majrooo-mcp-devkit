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
});