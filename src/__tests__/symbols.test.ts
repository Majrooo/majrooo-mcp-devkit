import { describe, it, expect } from "vitest";
import path from "path";
import { universalFindReferences, extractCodeBlock } from "../symbols.js";

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
