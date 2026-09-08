# Project Context: majrooo-mcp-devkit

## Project Overview

* **Name:** majrooo-mcp-devkit
* **Description:** A custom MCP (Model Context Protocol) devkit that provides **safe command execution, code analysis and refactoring tools** for AI assistants (Cline/Claude Desktop). Commands run inside registered project roots; dangerous commands and writes outside the active root are rejected.
* **Repository:** https://github.com/Majrooo/majrooo-mcp-devkit (PUBLIC)
* **License:** GPL-3.0-or-later
* **Tech Stack:** Node.js / TypeScript (strict), MCP SDK, Zod
* **Package Manager:** npm
* **Dependencies / Requirements:** `@modelcontextprotocol/sdk`, `zod` (runtime); `typescript`, `vitest`, `@types/node` (dev) — see `package.json`.

## Architecture & Conventions

* **Architecture:** MCP server over stdio (`StdioServerTransport`). Module split:
  * `src/index.ts` — tool registration (`server.tool`), command execution, audit log, output normalization wiring, redirect reporting wiring.
  * `src/safety.ts` — allowed-roots registry, dangerous-pattern blacklist, directory-escape detection, write/read-target heuristics, project discovery, `extractRedirectTargets`, `extractDestructiveTargets`.
  * `src/output.ts` — `stripAnsi` + `withUtf8Encoding` helpers.
  * `src/format.ts` — structured failure formatting (exit code / signal / timeout, captured output, `formatCommandError`).
  * `src/redirect.ts` — redirect-target reporting: reads back files written via `>` / `>>` / `2>` and shows their tail in the response.
* **State Management:** N/A (stateless request-response); persistent audit log in `os.tmpdir()/mcp-command-audit.log`.
* **Styling:** N/A
* **Testing:** Vitest — `npm test` (211 tests across `output`, `safety`, `format`, `redirect`, `symbols`, `split`, `batch`, `skeleton`, `verify`, `feedback` suites, run only on `src/__tests__` — `build/` is excluded from the test pattern).
* **File Structure:**
  * `src/` — TypeScript sources (`index.ts`, `safety.ts`, `output.ts`, `format.ts`, `redirect.ts`, `symbols.ts`, `split.ts`, `batch.ts`, `skeleton.ts`, `verify.ts`, `feedback.ts`, `__tests__/`)
  * `build/` — compiled JS output from `tsc` (server launched as `node build/index.js`)
  * `README.md`, `PROJECT_CONTEXT.md`, `package.json`, `tsconfig.json`

## Tools

1. `run_safe_command` — default command executor (safety checks, 60s timeout, output truncation to temp log).
2. `run_destructive_command` — dangerous commands only after explicit user confirmation (`confirm: true`).
3. `read_log_slice` — read a line slice of a saved log (Node.js-direct, works in `os.tmpdir()`).
4. `run_command_grep` — run a command and return only lines matching a case-insensitive regex (Windows grep replacement).
5. `list_allowed_roots` — list registered roots / concrete projects usable as `cwd` (configuration only).
6. `resolve_cwd` — verify a path or friendly project name against the allowed roots (configuration only); returns `exists` indicating whether the resolved directory exists on disk.
7. `universal_find_references` — find all occurrences of a symbol across a workspace (read-only, structured output with optional language-aware role detection).
8. `extract_code_block` — extract the full text of a function/struct/class from a file (annotation-aware, string/comment-safe bracket matching).
9. `split_file_by_declarations` — split a large file into multiple smaller files based on top-level declarations (dryRun default, index generation).
10. `batch_apply_edits` — apply multiple file edits atomically with rollback on failure (validation before write, dryRun default).
11. `generate_module_skeleton` — generate a new module file with extracted symbols from a source file (unknown symbols error, dryRun default).
12. `verify_refactor_safety` — semantic diff between old and new code; catches accidental deletions (function count, signatures, exports, imports, comment ratio).
13. `report_tool_feedback` — report bugs, improvements, or feature requests about any MCP tool (writes to `.mcp/FEEDBACK.md`, idempotent, project-protected).

## Configuration (environment)

| Var | Purpose |
|---|---|
| `MCP_PROJECT_ROOT` | Primary project root (default `cwd`; fallback = server's own dir). |
| `MCP_EXTRA_ROOTS` | Additional roots, semicolon-separated (plain paths and/or globs). |
| `MCP_PROJECT_NAMES` | Friendly names `path=name;...` usable as `cwd`. |
| `MCP_BLOCK_CROSS_ROOT_READS` | `1`/`true` → opt-in blocking of obvious cross-root reads. |

## Key User Workflows

1. **Discover projects:** `list_allowed_roots` → find the right `cwd` (or friendly name).
2. **Run a command:** `run_safe_command` with `command` (+ `cwd`, optional `maxLines`/`timeoutMs`). Long outputs are truncated and saved to `os.tmpdir()`.
3. **Filter output:** `run_command_grep` with a `pattern` instead of Unix `grep`.
4. **Inspect long logs:** `read_log_slice` with the saved log path.
5. **Dangerous op:** `run_destructive_command` after the user explicitly confirms the risk.

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript (`tsc` → `build/`) |
| `npm test` | Run Vitest unit tests (211 tests, `src/__tests__` only) |
| `npm run test:watch` | Vitest watch mode (`src/__tests__`) |
| `node build/index.js` | Run the MCP server (STDIO) |
| `npm ls --depth=0` | List installed dependencies |

## Safety Model (best-effort)

- Registered roots restrict `cwd`; `cd ..`, `cd /d`, `pushd` escapes blocked.
- Dangerous-pattern blacklist (destructive git, rm -rf, format, fork bombs, curl|bash, ...).
- Write-target checks for redirects / `copy` / `mkdir` / `tee` / `curl -o` / `git -C` etc.; opt-in cross-root read checks.
- Missing destructive target: a confirmed destructive command (`rmdir`/`del`/`erase`/`Remove-Item`) whose target does not exist in the active `cwd` is rejected with a "set the `cwd` parameter" message (audit reason `missing_destructive_target`).
- Redirected output reporting: when a command writes into a file (`>` / `>>` / `2>`), the response shows where the output went and the tail of the file; failures include exit code / timeout / captured output.
- **NOT a security guarantee** — shell features can bypass heuristics; use Docker/VM for isolation.
- Output normalization: Windows `chcp 65001` prefix (UTF-8), ANSI stripping, `NO_COLOR`/`FORCE_COLOR`.
