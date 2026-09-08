import { describe, it, expect } from "vitest";
import { verifyRefactorSafety } from "../verify.js";

const TS_BEFORE = `
import { Logger } from "./logger";

export function calculate(x: number): number {
  return x * 2;
}

export class Config {
  name: string;
  // constructor
  constructor(name: string) { this.name = name; }
}

export function transform(data: string): string {
  // process data
  return data.trim();
}
`;

describe("verifyRefactorSafety", () => {
  it("identical input → safe: true", () => {
    const r = verifyRefactorSafety(TS_BEFORE, TS_BEFORE);
    expect(r.safe).toBe(true);
    expect(r.checks.every((c) => c.status !== "error")).toBe(true);
  });

  it("removed function → safe: false, error on function_count", () => {
    const after = TS_BEFORE.replace(/export function transform[\s\S]*?}\n/, "");
    const r = verifyRefactorSafety(TS_BEFORE, after);
    expect(r.safe).toBe(false);
    expect(r.checks.find((c) => c.check === "function_count")!.status).toBe("error");
  });

  it("changed signature → safe: false, error on function_signatures", () => {
    const after = TS_BEFORE.replace("calculate(x: number): number", "calculate(x: string): string");
    const r = verifyRefactorSafety(TS_BEFORE, after);
    expect(r.safe).toBe(false);
    expect(r.checks.find((c) => c.check === "function_signatures")!.status).toBe("error");
  });

  it("added imports only → safe: true with info", () => {
    const after = `import { Extra } from "./extra";\n` + TS_BEFORE;
    const r = verifyRefactorSafety(TS_BEFORE, after);
    expect(r.safe).toBe(true);
    const importCheck = r.checks.find((c) => c.check === "import_changes");
    expect(importCheck).toBeDefined();
    expect(importCheck!.status).toBe("info");
  });

  it("whitespace-only changes → all checks pass", () => {
    const after = TS_BEFORE.replace("return x * 2;", "  return x * 2;");
    const r = verifyRefactorSafety(TS_BEFORE, after);
    expect(r.safe).toBe(true);
  });

  it("renamed function → safe: false (conservative)", () => {
    const after = TS_BEFORE.replace("calculate", "compute");
    const r = verifyRefactorSafety(TS_BEFORE, after);
    expect(r.safe).toBe(false);
    expect(r.checks.find((c) => c.check === "function_count")!.status).toBe("error");
  });

  it("comment ratio: >30% removal → warning", () => {
    const before = `// comment 1\n// comment 2\n// comment 3\n// comment 4\nexport function f() {}\n`;
    const after = `export function f() {}\n`;
    const r = verifyRefactorSafety(before, after);
    const ratioCheck = r.checks.find((c) => c.check === "comment_ratio");
    expect(ratioCheck).toBeDefined();
    expect(ratioCheck!.status).toBe("warning");
  });

  it("summary counts are correct", () => {
    const r = verifyRefactorSafety(TS_BEFORE, TS_BEFORE);
    expect(r.summary.functionsBefore).toBe(r.summary.functionsAfter);
    expect(r.summary.linesBefore).toBe(r.summary.linesAfter);
  });

  it("export count warning when exports change", () => {
    const after = TS_BEFORE.replace("export function calculate", "function calculate");
    const r = verifyRefactorSafety(TS_BEFORE, after);
    const exportCheck = r.checks.find((c) => c.check === "export_count");
    expect(exportCheck).toBeDefined();
    expect(exportCheck!.status).toBe("warning");
  });

  it("works with Rust code", () => {
    const before = `pub fn calc(x: i32) -> i32 { x * 2 }\npub struct Config { name: String }`;
    const after = `pub fn calc(x: i32) -> i32 { x * 2 }`;
    const r = verifyRefactorSafety(before, after, { language: "rust" });
    expect(r.safe).toBe(false);
    expect(r.checks.find((c) => c.check === "function_count")!.status).toBe("error");
  });

  it("works with Python code", () => {
    const before = `def calc(x):\n    return x * 2\n\nclass Config:\n    pass`;
    const after = `def calc(x):\n    return x * 2`;
    const r = verifyRefactorSafety(before, after, { language: "python" });
    expect(r.safe).toBe(false);
  });
});
