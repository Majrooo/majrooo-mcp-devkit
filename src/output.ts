/*
 * majrooo-mcp-devkit
 * Copyright (C) 2026 majrooo <https://github.com/majrooo>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// src/output.ts — output normalization helpers for command execution.

/**
 * Strip ANSI/VT escape sequences (CSI, OSC and other control sequences) from
 * command output. Tools like vitest/jest emit color codes (e.g. ESC[32m) that
 * would otherwise appear as raw garbage in the MCP response.
 */
export function stripAnsi(text: string): string {
  // Strip OSC sequences (ESC ] ... BEL / ESC \) FIRST — they may start with
  // digits+semicolons (e.g. `ESC]0;My Title BEL`) that the CSI regex below
  // would otherwise partially consume as a broken SGR sequence.
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\u001B\][^\u0007\u001B\\]*(?:\u0007|\u001B\\)/g, "")
    // CSI / other ANSI/VT escape sequences (colors, cursor moves, etc.).
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;[\dA-PR-TZcf-ntqry=><~]{0,4})?)+[\dA-PR-TZcf-ntqry=><~]))/g, "");
}

/**
 * On Windows, cmd.exe emits legacy-encoding output (e.g. CP852/CP1250) for
 * tools like `dir` and `chcp`. Force the child process to UTF-8 (codepage
 * 65001) so the output decodes cleanly instead of producing U+FFFD replacement
 * characters (``). The codepage switch only wraps execution — safety checks
 * and the audit log still use the original command.
 */
export function withUtf8Encoding(command: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `chcp 65001 > NUL && ${command}` : command;
}