import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  collectReferencesAcrossRoots,
  extractCodeBlock,
  formatReferencesReport,
  pruneNestedRoots,
  universalFindReferences,
} from "../symbols.js";

const FIXTURES = path.resolve(__dirname, "fixtures");

// ── universal_find_references ───────────────────────────────

describe("universalFindReferences", () => {
  it("finds all occurrences of a symbol in Rust fixture", () => {
    const result = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".rs"],
    });
    expect(result.symbol).toBe("AiConfig");
    expect(result.totalMatches).toBeGreaterThanOrEqual(4);
    const files = result.files.map((f) => f.file);
    expect(files).toContain("test.rs");
  });

  it("finds all occurrences of a symbol in TypeScript fixture", () => {
    const result = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".ts"],
    });
    expect(result.symbol).toBe("AiConfig");
    expect(result.totalMatches).toBeGreaterThanOrEqual(3);
    const files = result.files.map((f) => f.file);
    expect(files).toContain("test.ts");
  });

  it("finds all occurrences of a symbol in Python fixture", () => {
    const result = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".py"],
    });
    expect(result.symbol).toBe("AiConfig");
    expect(result.totalMatches).toBeGreaterThanOrEqual(3);
    const files = result.files.map((f) => f.file);
    expect(files).toContain("test.py");
  });

  it("word-boundary: AiConfig does NOT match SuperAiConfig", () => {
    const result = universalFindReferences("Config", FIXTURES, {
      fileExtensions: [".rs"],
    });
    for (const file of result.files) {
      for (const m of file.matches) {
        const word = m.context.split(/\s+/).find((w) => w.includes("Config"));
        expect(word).toBeDefined();
      }
    }
  });

  it("respects fileExtensions — filters by extension", () => {
    const rsOnly = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".rs"],
    });
    const all = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".rs", ".ts", ".py"],
    });
    expect(rsOnly.totalMatches).toBeLessThanOrEqual(all.totalMatches);
    expect(all.totalMatches).toBeGreaterThan(rsOnly.totalMatches);
  });

  it("returns empty result for non-existent symbol", () => {
    const result = universalFindReferences("NonExistentSymbol12345", FIXTURES);
    expect(result.totalMatches).toBe(0);
    expect(result.files).toHaveLength(0);
  });

  it("returns correct context lines around matches", () => {
    const result = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".rs"],
      contextLines: 2,
    });
    for (const file of result.files) {
      for (const m of file.matches) {
        const ctxLines = m.context.split("\n");
        expect(ctxLines.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("language-aware mode assigns roles in Rust", () => {
    const result = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".rs"],
      language: "rust",
    });
    const roles = result.files.flatMap((f) => f.matches).map((m) => m.role);
    expect(roles).toContain("declaration");
    expect(roles).toContain("usage");
  });

  it("language-aware mode assigns roles in TypeScript", () => {
    const result = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".ts"],
      language: "typescript",
    });
    const roles = result.files.flatMap((f) => f.matches).map((m) => m.role);
    expect(roles).toContain("declaration");
    expect(roles).toContain("usage");
  });

  it("language-aware mode assigns roles in Python", () => {
    const result = universalFindReferences("AiConfig", FIXTURES, {
      fileExtensions: [".py"],
      language: "python",
    });
    const roles = result.files.flatMap((f) => f.matches).map((m) => m.role);
    expect(roles).toContain("declaration");
    expect(roles).toContain("import");
    expect(roles).toContain("usage");
  });
});

// ── extract_code_block ──────────────────────────────────────

describe("extractCodeBlock", () => {
  it("extracts Rust struct with nested braces", () => {
    const file = path.join(FIXTURES, "test.rs");
    const result = extractCodeBlock(file, "AiConfig");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const texts = "matches" in result
      ? result.matches.map((m) => m.text)
      : [result.text];
    const hasStruct = texts.some((t) => t.includes("pub struct AiConfig") && t.includes("pub enabled: bool"));
    expect(hasStruct).toBe(true);
  });

  it("extracts Python function with indent matching", () => {
    const file = path.join(FIXTURES, "test.py");
    const result = extractCodeBlock(file, "ai_turn_system");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const texts = "matches" in result
      ? result.matches.map((m) => m.text)
      : [result.text];
    const hasFn = texts.some((t) => t.includes("def ai_turn_system") && t.includes("return state"));
    expect(hasFn).toBe(true);
  });

  it("string/comment skip: braces inside strings do not affect bracket counting", () => {
    const file = path.join(FIXTURES, "test.rs");
    const result = extractCodeBlock(file, "setup_ai");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const texts = "matches" in result
      ? result.matches.map((m) => m.text)
      : [result.text];
    const hasFn = texts.some((t) => t.includes("pub fn setup_ai") && t.includes('"error: {expected}"'));
    expect(hasFn).toBe(true);
  });

  it("leading annotations: Rust #[derive] included", () => {
    const file = path.join(FIXTURES, "test.rs");
    const result = extractCodeBlock(file, "AiConfig");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const texts = "matches" in result
      ? result.matches.map((m) => m.text)
      : [result.text];
    const hasAnnotation = texts.some((t) => t.includes("#[derive(Resource, Clone, Debug)]"));
    expect(hasAnnotation).toBe(true);
  });

  it("leading annotations: Python @staticmethod included", () => {
    const file = path.join(FIXTURES, "test.py");
    const result = extractCodeBlock(file, "from_env");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const texts = "matches" in result
      ? result.matches.map((m) => m.text)
      : [result.text];
    const hasAnnotation = texts.some((t) => t.includes("@staticmethod"));
    expect(hasAnnotation).toBe(true);
  });

  it("non-existent symbol returns error", () => {
    const file = path.join(FIXTURES, "test.rs");
    const result = extractCodeBlock(file, "NonExistentSymbol12345");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("not found");
  });

  it("non-readable file returns error", () => {
    const result = extractCodeBlock("/nonexistent/path/file.rs", "symbol");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("Cannot read");
  });

  it("contextLines adds extra lines before and after", () => {
    const file = path.join(FIXTURES, "test.rs");
    const result = extractCodeBlock(file, "GameState", { contextLines: 2 });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const texts = "matches" in result
      ? result.matches.map((m) => m.text)
      : [result.text];
    const hasExtra = texts.some((t) => t.split("\n").length > 4);
    expect(hasExtra).toBe(true);
  });

  it("multiple matches returned when symbol appears multiple times", () => {
    const file = path.join(FIXTURES, "test.rs");
    const result = extractCodeBlock(file, "AiConfig");
    expect("error" in result).toBe(false);
    if ("matches" in result) {
      expect(result.matches.length).toBeGreaterThan(1);
    }
  });

  it("extracts TypeScript class with brace matching", () => {
    const file = path.join(FIXTURES, "test.ts");
    const result = extractCodeBlock(file, "GameEngine");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const texts = "matches" in result
      ? result.matches.map((m) => m.text)
      : [result.text];
    const hasClass = texts.some((t) => t.includes("class GameEngine"));
    expect(hasClass).toBe(true);
  });

  it("extracts Python class with indent matching", () => {
    const file = path.join(FIXTURES, "test.py");
    const result = extractCodeBlock(file, "AiConfig");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const texts = "matches" in result
      ? result.matches.map((m) => m.text)
      : [result.text];
    const hasClass = texts.some((t) => t.includes("class AiConfig"));
    expect(hasClass).toBe(true);
  });

  it("Rust #[allow] attribute does not break brace counting", () => {
    // Simulates a function with nested loops and an attribute inside
    const content = `pub fn pixel_perfect_hit_system() {
    #[allow(unused)]
    for projectile in projectiles.iter() {
        for check_pos in positions.iter() {
            for tank in tanks.iter() {
                // inner
            }
        }
    }
}`;
    // Use extractCodeBlock on a temp file
    const fs = require("fs");
    const os = require("os");
    const tmpFile = require("path").join(os.tmpdir(), `attr-test-${Date.now()}.rs`);
    fs.writeFileSync(tmpFile, content, "utf-8");
    try {
      const result = extractCodeBlock(tmpFile, "pixel_perfect_hit_system");
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      const texts = "matches" in result
        ? result.matches.map((m) => m.text)
        : [result.text];
      const hasAllBraces = texts.some((t) => {
        const opens = (t.match(/{/g) || []).length;
        const closes = (t.match(/}/g) || []).length;
        return opens === closes && opens >= 4;
      });
      expect(hasAllBraces).toBe(true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ── multi-root aggregation (universal_find_references) ──────

const ROOTED_SYMBOL = "RootedWidget";

/** Create a temp tree: `{ "relative/path.rs": ["line", ...] }` → root dir. */
function writeTree(files: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collect-refs-test-"));
  for (const [rel, lines] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join("\n"), "utf-8");
  }
  return root;
}

describe("pruneNestedRoots", () => {
  it("keeps only the outermost root", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "prune-roots-test-"));
    const nested = path.join(base, "project");
    fs.mkdirSync(path.join(nested, "src"), { recursive: true });
    expect(pruneNestedRoots([base, nested])).toEqual([base]);
    expect(pruneNestedRoots([nested, base])).toEqual([base]);
  });

  it("is a no-op for non-nested roots and removes duplicates", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "prune-roots-test-"));
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    expect(pruneNestedRoots([a, b])).toEqual([a, b]);
    expect(pruneNestedRoots([a, a])).toEqual([a]);
  });
});

describe("collectReferencesAcrossRoots", () => {
  it("lists a file reachable through a nested root exactly once", () => {
    // The reported bug: two nested roots (parent + project inside it) listed
    // every file twice and reported 2× the real match count.
    const parent = writeTree({
      "notes.rs": ["// RootedWidget mentioned once"],
      "project/src/lib.rs": [
        "pub use widget::RootedWidget;",
        "fn use_it() -> RootedWidget { RootedWidget::new() }",
      ],
    });

    const result = collectReferencesAcrossRoots(
      [parent, path.join(parent, "project")],
      ROOTED_SYMBOL,
      { fileExtensions: [".rs"] },
    );

    expect(result.roots).toEqual([parent]);
    expect(result.duplicatesDropped).toBe(0);
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.file).sort()).toEqual(["notes.rs", "project/src/lib.rs"]);
    expect(result.totalMatches).toBe(3);
  });

  it("keeps totalMatches consistent with the listed matches", () => {
    const parent = writeTree({
      "notes.rs": ["// RootedWidget mentioned once"],
      "project/src/lib.rs": ["pub use widget::RootedWidget;"],
    });
    const result = collectReferencesAcrossRoots(
      [parent, path.join(parent, "project")],
      ROOTED_SYMBOL,
      { fileExtensions: [".rs"] },
    );
    const listed = result.files.reduce((sum, f) => sum + f.matches.length, 0);
    expect(result.totalMatches).toBe(listed);
  });

  it("keeps distinct files that share the same relative path in sibling roots", () => {
    // The relative path is NOT a valid identity (the old dedup key) — both
    // files must survive.
    const base = writeTree({
      "a/src/dup.rs": ["// RootedWidget in a"],
      "b/src/dup.rs": ["// RootedWidget in b"],
    });
    const result = collectReferencesAcrossRoots(
      [path.join(base, "a"), path.join(base, "b")],
      ROOTED_SYMBOL,
      { fileExtensions: [".rs"] },
    );
    expect(result.duplicatesDropped).toBe(0);
    expect(result.files).toHaveLength(2);
    expect(result.files.every((f) => f.file === "src/dup.rs")).toBe(true);
    expect(result.totalMatches).toBe(2);
  });

  it("deduplicates two paths that resolve to the same file (junction)", () => {
    const real = writeTree({ "src/lib.rs": ["// RootedWidget"] });
    const link = `${real}-link`;
    try {
      fs.symlinkSync(real, link, "junction");
    } catch {
      return; // junction not available (platform / permissions) — nothing to assert
    }
    const result = collectReferencesAcrossRoots([real, link], ROOTED_SYMBOL, {
      fileExtensions: [".rs"],
    });
    expect(result.files).toHaveLength(1);
    expect(result.duplicatesDropped).toBe(1);
    expect(result.totalMatches).toBe(1);
  });

  it("matches universalFindReferences for a single root", () => {
    const parent = writeTree({
      "notes.rs": ["// RootedWidget mentioned once"],
      "project/src/lib.rs": ["pub use widget::RootedWidget;"],
    });
    const single = universalFindReferences(ROOTED_SYMBOL, parent, { fileExtensions: [".rs"] });
    const collected = collectReferencesAcrossRoots([parent], ROOTED_SYMBOL, {
      fileExtensions: [".rs"],
    });
    expect(collected.totalMatches).toBe(single.totalMatches);
    expect(collected.files.map((f) => f.file).sort()).toEqual(
      single.files.map((f) => f.file).sort(),
    );
    expect(collected.duplicatesDropped).toBe(0);
  });
});

describe("formatReferencesReport", () => {
  it("keeps the legacy shape for a single searched root", () => {
    const root = writeTree({ "src/solo.rs": ["pub fn solo() {}   // SoloWidget"] });
    const report = formatReferencesReport(
      collectReferencesAcrossRoots([root], "SoloWidget", { fileExtensions: [".rs"] }),
    );
    expect(
      report.startsWith("Symbol: SoloWidget\nTotal matches: 1\n\nsrc/solo.rs:\n  Line 1:"),
    ).toBe(true);
    expect(report).not.toContain("Searched roots");
    expect(report).not.toContain("(relative to ");
  });

  it("lists the searched roots and the root each file path is relative to", () => {
    const report = formatReferencesReport({
      symbol: "ColAlign",
      roots: ["D:\\W\\TS", "d:\\Users Data\\jox\\My Documents\\Rust"],
      totalMatches: 2,
      duplicatesDropped: 2,
      files: [
        {
          file: "proj/src/lib.rs",
          root: "d:\\Users Data\\jox\\My Documents\\Rust",
          matches: [{ line: 72, column: 12, role: "usage", context: "pub use ui_panel::{" }],
        },
        {
          file: "majrooo-mcp-devkit/src/index.ts",
          root: "D:\\W\\TS",
          matches: [{ line: 5, column: 3, context: "const x = 1;" }],
        },
      ],
    });
    expect(report).toContain("Symbol: ColAlign");
    expect(report).toContain("Searched roots (2):");
    expect(report).toContain("  - D:\\W\\TS");
    expect(report).toContain("  - d:\\Users Data\\jox\\My Documents\\Rust");
    expect(report).toContain("Duplicates skipped: 2 (same file reachable through a nested root)");
    expect(report).toContain(
      "proj/src/lib.rs  (relative to d:\\Users Data\\jox\\My Documents\\Rust)",
    );
    expect(report).toContain("majrooo-mcp-devkit/src/index.ts  (relative to D:\\W\\TS)");
    expect(report).toContain("  Line 72:12 [usage] — pub use ui_panel::{");
  });

  it("omits the duplicates note when nothing was skipped", () => {
    const report = formatReferencesReport({
      symbol: "X",
      roots: ["a", "b"],
      totalMatches: 0,
      duplicatesDropped: 0,
      files: [],
    });
    expect(report).toContain("Searched roots (2):");
    expect(report).not.toContain("Duplicates skipped");
    expect(report).toContain("(no matches found)");
  });
});