import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { generateModuleSkeleton } from "../skeleton.js";

const FIXTURES = path.resolve(__dirname, "fixtures");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skeleton-test-"));
}
function cleanupDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
}

describe("generateModuleSkeleton", () => {
  let tmp: string;
  afterEach(() => { if (tmp) cleanupDir(tmp); tmp = ""; });

  it("dry-run returns content without writing", () => {
    const src = path.join(FIXTURES, "test.rs");
    const result = generateModuleSkeleton("/tmp/out.rs", ["AiConfig"], src, { dryRun: true });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.dryRun).toBe(true);
    expect(result.content).toContain("AiConfig");
  });

  it("writes module file with extracted symbols", () => {
    tmp = tmpDir();
    const target = path.join(tmp, "config.rs");
    const src = path.join(FIXTURES, "test.rs");
    const result = generateModuleSkeleton(target, ["AiConfig", "setup_ai"], src, { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, "utf-8");
    expect(content).toContain("AiConfig");
    expect(content).toContain("setup_ai");
  });

  it("unknown symbols return error with unknownSymbols list", () => {
    const src = path.join(FIXTURES, "test.rs");
    const result = generateModuleSkeleton("/tmp/out.rs", ["KnownFn", "NonExistentXYZ"], src);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.unknownSymbols).toContain("NonExistentXYZ");
    }
  });

  it("overwrite refusal when target exists", () => {
    tmp = tmpDir();
    const target = path.join(tmp, "exists.rs");
    fs.writeFileSync(target, "old", "utf-8");
    const src = path.join(FIXTURES, "test.rs");
    const result = generateModuleSkeleton(target, ["AiConfig"], src, { dryRun: false, overwrite: false });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("already exists");
  });

  it("overwrite: true allows writing over existing file", () => {
    tmp = tmpDir();
    const target = path.join(tmp, "exists.rs");
    fs.writeFileSync(target, "old", "utf-8");
    const src = path.join(FIXTURES, "test.rs");
    const result = generateModuleSkeleton(target, ["AiConfig"], src, { dryRun: false, overwrite: true });
    expect("error" in result).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toContain("AiConfig");
  });

  it("Python: extracts class with imports", () => {
    tmp = tmpDir();
    const target = path.join(tmp, "config.py");
    const src = path.join(FIXTURES, "test.py");
    const result = generateModuleSkeleton(target, ["AiConfig"], src, { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(target, "utf-8");
    expect(content).toContain("class AiConfig");
  });

  it("TypeScript: extracts class", () => {
    tmp = tmpDir();
    const target = path.join(tmp, "engine.ts");
    const src = path.join(FIXTURES, "test.ts");
    const result = generateModuleSkeleton(target, ["GameEngine"], src, { dryRun: false });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(target, "utf-8");
    expect(content).toContain("class GameEngine");
  });
});