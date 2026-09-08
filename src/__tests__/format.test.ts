import { describe, it, expect } from "vitest";
import {
  describeFailure,
  extractExecFailure,
  formatCapturedOutput,
  formatCommandError,
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