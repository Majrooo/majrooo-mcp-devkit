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
// src/helpers.ts — shared utility functions (temp paths, audit log, line parsing)
import { appendFile, stat, rename } from "fs/promises";
import path from "path";
import os from "os";

export function getTempLogPath(): string {
  const timestamp = Date.now();
  return path.join(os.tmpdir(), `cmd-output-${timestamp}.log`);
}

export function parseLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function getAuditLogPath(): string {
  return path.join(os.tmpdir(), "mcp-command-audit.log");
}

/** Rotate the audit log when it exceeds this size (5 MB). */
export const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export async function writeAuditLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const auditPath = getAuditLogPath();
    // Best-effort rotation: if the log already exceeds the cap, move it aside
    // (overwriting the previous `.old`) and start a fresh file.
    try {
      const { size } = await stat(auditPath);
      if (size > AUDIT_LOG_MAX_BYTES) {
        await rename(auditPath, `${auditPath}.old`);
      }
    } catch {
      // File does not exist yet (or stat/rename raced) — that's fine.
    }
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(auditPath, line, "utf-8");
  } catch (err) {
    console.error("[audit-log] Failed to write audit entry:", err);
  }
}
