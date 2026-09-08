import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { splitFileByDeclarations } from "../split.js";

const FIXTURES = path.resolve(__dirname, "fixtures");

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "split-test-"));
  return d;
}

function cleanupDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
}

// ── split_file_by_declarations ──────────────────────────────

describe("splitFileByDeclarations", () => {
  let tmp: string;
  afterEach(() => { if (tmp) cleanupDir(tmp); tmp = ""; });

  it("dry-run returns preview without writing files", () => {
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "config.rs", symbols: ["AiConfig"] },
      { module: "game.rs", symbols: ["GameState"] },
    ], { dryRun: true });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.dryRun).toBe(true);
    expect(result.preview).toHaveLength(2);
    expect(result.preview[0]!.module).toBe("config.rs");
    expect(result.preview[1]!.module).toBe("game.rs");
    expect(result.preview[0]!.symbols).toContain("AiConfig");
    // Files should NOT exist
    for (const p of result.preview) {
      expect(fs.existsSync(p.targetFile)).toBe(false);
    }
  });

  it("splits Rust file into modules", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "config.rs", symbols: ["AiConfig", "setup_ai"] },
      { module: "game.rs", symbols: ["GameState", "ai_turn_system"] },
    ], { dryRun: false, targetDir: tmp });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.dryRun).toBe(false);
    expect(fs.existsSync(path.join(tmp, "config.rs"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "game.rs"))).toBe(true);

    const configContent = fs.readFileSync(path.join(tmp, "config.rs"), "utf-8");
    expect(configContent).toContain("AiConfig");
    expect(configContent).toContain("setup_ai");
  });

  it("generates index file for Rust (mod.rs)", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "config.rs", symbols: ["AiConfig"] },
    ], { dryRun: false, targetDir: tmp, generateIndex: true });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.indexFile).toBeDefined();
    expect(result.indexContent).toContain("pub mod config;");
    expect(result.indexContent).toContain("pub use config::*;");
  });

  it("generates index file for TypeScript (index.ts)", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.ts");
    const result = splitFileByDeclarations(src, [
      { module: "config.ts", symbols: ["AiConfig"] },
    ], { dryRun: false, targetDir: tmp, generateIndex: true });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.indexFile).toBeDefined();
    expect(result.indexContent).toContain("export * from './config';");
  });

  it("generates index file for Python (__init__.py)", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.py");
    const result = splitFileByDeclarations(src, [
      { module: "config.py", symbols: ["AiConfig"] },
    ], { dryRun: false, targetDir: tmp, generateIndex: true });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.indexFile).toBeDefined();
    expect(result.indexContent).toContain("from .config import *");
  });

  it("unknown symbols return error", () => {
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "bad.rs", symbols: ["NonExistent12345"] },
    ]);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("not found");
  });

  it("overwrite refusal when target exists", () => {
    tmp = tmpDir();
    const target = path.join(tmp, "exists.rs");
    fs.writeFileSync(target, "old content", "utf-8");
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "exists.rs", symbols: ["AiConfig"] },
    ], { dryRun: false, targetDir: tmp, overwrite: false });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("already exists");
  });

  it("source order preserved in extracted blocks", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "mixed.rs", symbols: ["AiConfig", "setup_ai"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(path.join(tmp, "mixed.rs"), "utf-8");
    const aiIdx = content.indexOf("AiConfig");
    const setupIdx = content.indexOf("setup_ai");
    expect(aiIdx).toBeLessThan(setupIdx);
  });

  it("leading annotations preserved after split", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "annotated.rs", symbols: ["AiConfig"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(path.join(tmp, "annotated.rs"), "utf-8");
    expect(content).toContain("#[derive(Resource, Clone, Debug)]");
  });

  it("cannot detect language returns error", () => {
    const result = splitFileByDeclarations("/fake/file.xyz", [{ module: "a.xyz", symbols: ["x"] }]);
    expect("error" in result).toBe(true);
  });
});