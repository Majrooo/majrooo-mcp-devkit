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

  it("imports are included in split output", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "config.rs", symbols: ["AiConfig"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(path.join(tmp, "config.rs"), "utf-8");
    expect(content).toContain("use std::collections::HashMap;");
    expect(content).toContain("use crate::ai::AiConfig;");
  });

  it("impl blocks are included for extracted types", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "config.rs", symbols: ["AiConfig"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(path.join(tmp, "config.rs"), "utf-8");
    expect(content).toContain("impl AiConfig {");
    expect(content).toContain("pub fn new(model_name: &str) -> Self");
  });

  it("impl blocks NOT included for types without impl", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "game.rs", symbols: ["GameState"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(path.join(tmp, "game.rs"), "utf-8");
    expect(content).toContain("pub struct GameState");
    // GameState has no impl block in the fixture
    expect(content).not.toContain("impl GameState");
  });

  it("private declarations are findable and extractable", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "priv.rs", symbols: ["MAX_RETRIES", "private_helper"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(path.join(tmp, "priv.rs"), "utf-8");
    expect(content).toContain("MAX_RETRIES");
    expect(content).toContain("fn private_helper");
  });

  it("dry-run reports imports and impl block counts", () => {
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "config.rs", symbols: ["AiConfig"] },
    ], { dryRun: true });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.imports).toBeDefined();
    expect(result.imports!.length).toBeGreaterThan(0);
    expect(result.imports!).toContain("use std::collections::HashMap;");
    expect(result.preview[0]!.implBlocks).toBe(1);
  });

  it("pub(crate) declarations are findable", () => {
    // Create a temporary file with pub(crate) syntax
    tmp = tmpDir();
    const src = path.join(tmp, "pubcrate.rs");
    fs.writeFileSync(src, [
      "pub(crate) fn internal_fn() -> i32 { 42 }",
      "pub(super) struct InternalStruct { pub x: i32 }",
    ].join("\n"), "utf-8");
    const result = splitFileByDeclarations(src, [
      { module: "out.rs", symbols: ["internal_fn", "InternalStruct"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(path.join(tmp, "out.rs"), "utf-8");
    expect(content).toContain("internal_fn");
    expect(content).toContain("InternalStruct");
  });

  it("cross-module references add use super:: imports", () => {
    tmp = tmpDir();
    const src = path.join(FIXTURES, "test.rs");
    const result = splitFileByDeclarations(src, [
      { module: "config.rs", symbols: ["AiConfig"] },
      { module: "game.rs", symbols: ["GameState", "ai_turn_system"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // game.rs references AiConfig from config.rs — should have use super::AiConfig;
    const gameContent = fs.readFileSync(path.join(tmp, "game.rs"), "utf-8");
    expect(gameContent).toContain("use super::AiConfig;");
    // config.rs does NOT reference GameState — no cross-module import
    const configContent = fs.readFileSync(path.join(tmp, "config.rs"), "utf-8");
    expect(configContent).not.toContain("use super::");
  });

  it("mod blocks are extractable (e.g. #[cfg(test)] mod tests)", () => {
    tmp = tmpDir();
    const src = path.join(tmp, "with_tests.rs");
    fs.writeFileSync(src, [
      "pub struct Foo { pub x: i32 }",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    use super::*;",
      "",
      "    #[test]",
      "    fn it_works() {",
      "        assert_eq!(1 + 1, 2);",
      "    }",
      "}",
    ].join("\n"), "utf-8");
    const result = splitFileByDeclarations(src, [
      { module: "foo.rs", symbols: ["Foo"] },
      { module: "tests.rs", symbols: ["tests"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const testsContent = fs.readFileSync(path.join(tmp, "tests.rs"), "utf-8");
    expect(testsContent).toContain("#[cfg(test)]");
    expect(testsContent).toContain("mod tests");
    expect(testsContent).toContain("fn it_works");
  });

  it("cfg-aware: symbol used only in cfg block gets cfg on import", () => {
    tmp = tmpDir();
    const src = path.join(tmp, "cfg_test.rs");
    fs.writeFileSync(src, [
      "pub struct Config { pub debug: bool }",
      "",
      "pub struct StartMode { pub x: i32 }",
      "",
      "pub fn init(cfg: &Config) {",
      "    #[cfg(not(debug_assertions))]",
      "    {",
      "        let _mode = StartMode { x: 1 };",
      "    }",
      "}",
    ].join("\n"), "utf-8");
    const result = splitFileByDeclarations(src, [
      { module: "types.rs", symbols: ["Config", "StartMode"] },
      { module: "init.rs", symbols: ["init"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const initContent = fs.readFileSync(path.join(tmp, "init.rs"), "utf-8");
    // StartMode is used only in #[cfg(not(debug_assertions))] → import should have same cfg
    expect(initContent).toContain("#[cfg(not(debug_assertions))]");
    expect(initContent).toContain("use super::StartMode;");
    // Config is used in non-cfg code → plain import (no cfg needed)
    expect(initContent).toContain("use super::Config;");
  });

  it("multi-line use statements are collected completely", () => {
    tmp = tmpDir();
    const src = path.join(tmp, "multiline.rs");
    fs.writeFileSync(src, `use std::collections::HashMap;
use crate::{
    TurnPhase,
    InGameSubState,
    Wind,
    Cannon,
};

pub struct Foo {
    pub value: u32,
}

pub fn bar() -> u32 {
    42
}
`, "utf-8");
    const result = splitFileByDeclarations(src, [
      { module: "foo.rs", symbols: ["Foo"] },
    ], { dryRun: false, targetDir: tmp });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const content = fs.readFileSync(path.join(tmp, "foo.rs"), "utf-8");
    // Must contain complete multi-line use block, not truncated
    expect(content).toContain("use crate::{");
    expect(content).toContain("    TurnPhase,");
    expect(content).toContain("    Cannon,");
    expect(content).toContain("};");
    expect(content).toContain("use std::collections::HashMap;");
  });
});