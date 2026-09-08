import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import path from "path";
import os from "os";
import {
  buildRedirectNote,
  filterRedirectTargets,
  pluralLines,
  readRedirectFile,
} from "../redirect.js";

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "redirect-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs = [];
});

describe("filterRedirectTargets", () => {
  it("drops NUL and /dev/null discard targets", () => {
    expect(filterRedirectTargets(["out.log", "NUL", "/dev/null", "nul"])).toEqual(["out.log"]);
  });

  it("drops wildcard patterns and empty strings", () => {
    expect(filterRedirectTargets(["", " *.log", "logs/*.txt"])).toEqual([]);
  });

  it("keeps plain file names", () => {
    expect(filterRedirectTargets(["a.log", "sub/b.log"])).toEqual(["a.log", "sub/b.log"]);
  });
});

describe("pluralLines", () => {
  it.each([
    [1, "1 riadok"],
    [2, "2 riadky"],
    [4, "4 riadky"],
    [5, "5 riadkov"],
    [0, "0 riadkov"],
  ])("pluralizes %i", (n, expected) => {
    expect(pluralLines(n)).toBe(expected);
  });
});

describe("readRedirectFile", () => {
  it("reads a small file fully", async () => {
    const dir = await makeTempDir();
    const p = path.join(dir, "out.log");
    await writeFile(p, "line1\nline2\nline3\n", "utf-8");

    const info = await readRedirectFile(p, 10);
    expect(info).toEqual({
      read: true,
      totalLines: 4,
      tail: ["line1", "line2", "line3", ""],
      truncated: false,
    });
  });

  it("keeps only the last maxLines lines", async () => {
    const dir = await makeTempDir();
    const p = path.join(dir, "out.log");
    await writeFile(p, "a\nb\nc\nd\ne\n", "utf-8");

    const info = await readRedirectFile(p, 2);
    expect(info).toEqual({
      read: true,
      totalLines: 6,
      tail: ["e", ""],
      truncated: true,
    });
  });

  it("returns null for a missing file", async () => {
    const dir = await makeTempDir();
    expect(await readRedirectFile(path.join(dir, "missing.log"), 10)).toBeNull();
  });
});

describe("buildRedirectNote", () => {
  it("returns null when there are no targets", async () => {
    const dir = await makeTempDir();
    expect(await buildRedirectNote([], dir, 10)).toBeNull();
    expect(await buildRedirectNote(["NUL"], dir, 10)).toBeNull();
  });

  it("reports a successfully written file with content", async () => {
    const dir = await makeTempDir();
    const p = path.join(dir, "test.log");
    await writeFile(p, "✓ test passed\n", "utf-8");

    const note = await buildRedirectNote(["test.log"], dir, 10);
    expect(note).toContain(`[Výstup presmerovaný do: ${p}]`);
    expect(note).toContain("✓ test passed");
    expect(note).toContain("[Obsah súboru");
  });

  it("reports an unreadable/missing target without crashing", async () => {
    const dir = await makeTempDir();
    const note = await buildRedirectNote(["missing.log"], dir, 10);
    expect(note).toContain("[Výstup presmerovaný do:");
    expect(note).toContain("sa nepodarilo prečítať");
  });

  it("handles multiple targets", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "a.log"), "AAA\n", "utf-8");
    await writeFile(path.join(dir, "b.log"), "BBB\n", "utf-8");

    const note = await buildRedirectNote(["a.log", "b.log"], dir, 10);
    expect(note).toContain("a.log");
    expect(note).toContain("AAA");
    expect(note).toContain("b.log");
    expect(note).toContain("BBB");
  });

  it("does not treat an fd-duplication (2>&1) as a bogus file target", async () => {
    // Regression: `npm test > test.log 2>&1` used to report an extra bogus
    // target `&1` (resolved to `<cwd>\&1`). buildRedirectNote must skip it.
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "test.log"), "ok\n", "utf-8");

    const note = await buildRedirectNote(["test.log", "&1"], dir, 10);
    expect(note).toContain("test.log");
    expect(note).toContain("ok");
    expect(note).not.toContain("&1");
  });
});
