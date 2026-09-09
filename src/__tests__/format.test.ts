import { describe, it, expect } from "vitest";
import {
  describeFailure,
  extractExecFailure,
  formatCapturedOutput,
  formatCommandError,
  textResult,
  jsonResult,
} from "../format.js";

describe("extractExecFailure", () => {
  it("extracts exit code and captured output from a Node exec error", () => {
    const error = {
      message: "Command failed: npm test",
      code: 1,
      signal: null,
      killed: false,
      stdout: "stdout line\n",
      stderr: "stderr line\n",
    };
    expect(extractExecFailure(error)).toEqual({
      exitCode: 1,
      signal: null,
      killed: false,
      capturedStdout: "stdout line\n",
      capturedStderr: "stderr line\n",
    });
  });

  it("extracts a signal (SIGTERM) timeout rejection", () => {
    const error = {
      message: "Command failed: npm test",
      code: null,
      signal: "SIGTERM",
      killed: true,
      stdout: "",
      stderr: "",
    };
    expect(extractExecFailure(error)).toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
      killed: true,
    });
  });

  it("returns empty defaults for unknown errors", () => {
    expect(extractExecFailure("plain string")).toEqual({
      exitCode: null,
      signal: null,
      killed: false,
      capturedStdout: "",
      capturedStderr: "",
    });
  });

  it("returns empty defaults for null", () => {
    expect(extractExecFailure(null)).toEqual({
      exitCode: null,
      signal: null,
      killed: false,
      capturedStdout: "",
      capturedStderr: "",
    });
  });
});

describe("describeFailure", () => {
  it("describes a non-zero exit code", () => {
    expect(
      describeFailure({ exitCode: 1, signal: null, killed: false, capturedStdout: "", capturedStderr: "" }),
    ).toBe("exit code 1");
  });

  it("describes a plain signal", () => {
    expect(
      describeFailure({ exitCode: null, signal: "SIGKILL", killed: false, capturedStdout: "", capturedStderr: "" }),
    ).toBe("príkaz bol ukončený signálom SIGKILL");
  });

  it("describes a timeout as SIGTERM when killed", () => {
    expect(
      describeFailure({ exitCode: null, signal: "SIGTERM", killed: true, capturedStdout: "", capturedStderr: "" }),
    ).toBe("príkaz bol ukončený kvôli timeoutu (SIGTERM)");
  });

  it("falls back to unknown error", () => {
    expect(
      describeFailure({ exitCode: null, signal: null, killed: false, capturedStdout: "", capturedStderr: "" }),
    ).toBe("neznáma chyba");
  });
});

describe("formatCapturedOutput", () => {
  it("combines stdout and stderr with a STDERR marker", () => {
    expect(formatCapturedOutput("out", "err", 10)).toBe("out\nSTDERR:\nerr");
  });

  it("returns empty string when there is no captured output", () => {
    expect(formatCapturedOutput("", "", 10)).toBe("");
  });

  it("keeps only the last maxLines lines", () => {
    const many = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
    expect(formatCapturedOutput(many, "", 2)).toBe("line 3\nline 4");
  });

  it("strips ANSI codes", () => {
    expect(formatCapturedOutput("\u001B[32mgreen\u001B[39m", "", 10)).toBe("green");
  });
});

describe("formatCommandError", () => {
  it("explains Windows not-recognized errors", () => {
    const out = formatCommandError("'grep' is not recognized as an internal or external command");
    expect(out).toContain("'grep' nie je dostupný príkaz");
    expect(out).toContain("run_command_grep");
  });

  it("passes through other errors unchanged", () => {
    const raw = "some other error";
    expect(formatCommandError(raw)).toBe(raw);
  });
});

describe("textResult", () => {
  it("returns a CallToolResult with plain text", () => {
    const result = textResult("hello world");
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    expect(block.type).toBe("text");
    expect((block as { type: "text"; text: string }).text).toBe("hello world");
  });

  it("preserves newlines in text", () => {
    const result = textResult("line1\nline2\nline3");
    const block = result.content[0] as { type: "text"; text: string };
    expect(block.text).toBe("line1\nline2\nline3");
  });

  it("does not have isError", () => {
    const result = textResult("ok");
    expect(result.isError).toBeUndefined();
  });
});

describe("jsonResult", () => {
  it("returns pretty-printed JSON", () => {
    const result = jsonResult({ foo: "bar", count: 42 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('"foo": "bar"');
    expect(text).toContain('"count": 42');
  });

  it("handles nested objects", () => {
    const result = jsonResult({ items: [{ id: 1 }] });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.items[0].id).toBe(1);
  });
});