import { describe, it, expect } from "vitest";
import { stripAnsi, withUtf8Encoding } from "../output.js";

// ── stripAnsi ──────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes foreground color codes", () => {
    expect(stripAnsi("\u001B[32m✓\u001B[39m src/__tests__/tools.test.ts")).toBe(
      "✓ src/__tests__/tools.test.ts",
    );
  });

  it("removes dim/bold SGR codes inside vitest summary", () => {
    const input =
      "\u001B[2m(\u001B[22m\u001B[2m2 tests\u001B[22m\u001B[2m)\u001B[22m" +
      "\u001B[32m 4\u001B[2mms\u001B[22m\u001B[39m";
    expect(stripAnsi(input)).toBe("(2 tests) 4ms");
  });

  it("removes combined codes like Test Files 11 passed", () => {
    const input =
      "\u001B[2m Test Files \u001B[22m \u001B[1m\u001B[32m11 passed\u001B[39m\u001B[22m\u001B[90m (11)\u001B[39m";
    expect(stripAnsi(input)).toBe(" Test Files  11 passed (11)");
  });

  it("removes cursor/erase sequences", () => {
    expect(stripAnsi("\u001B[2K\u001B[1Ghello")).toBe("hello");
  });

  it("removes OSC sequence (e.g. window title)", () => {
    expect(stripAnsi("\u001B]0;My Title\u0007content")).toBe("content");
  });

  it("leaves plain text untouched", () => {
    const text = "3 196 features.md  (plain, no ansi)";
    expect(stripAnsi(text)).toBe(text);
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

// ── withUtf8Encoding ───────────────────────────────────────

describe("withUtf8Encoding", () => {
  it("prefixes chcp 65001 on win32", () => {
    expect(withUtf8Encoding("dir docs", "win32")).toBe("chcp 65001 > NUL && dir docs");
  });

  it("keeps the command unchanged on non-Windows platforms", () => {
    expect(withUtf8Encoding("ls -la", "linux")).toBe("ls -la");
    expect(withUtf8Encoding("ls -la", "darwin")).toBe("ls -la");
  });

  it("does not interfere with shell operators in the chained command", () => {
    // Avoid chained `&&` matching the injected prefix in tests — the prefix
    // itself contains `&&`, but the original command is preserved verbatim.
    expect(withUtf8Encoding("npm test 2>&1", "win32")).toBe("chcp 65001 > NUL && npm test 2>&1");
  });
});