# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `batch_apply_edits`: explicit machine-readable outcome — every response now carries `message` (human summary), `appliedEdits` (edits whose changes are on disk), `written` (files changed on disk) and `applied: true|false` on each `preview` entry. Failure responses additionally carry `reason` (`validation_failed` | `write_failed`), `reverted` (files rolled back) and `nothingWritten`. A validation failure now says plainly `VALIDATION FAILED on edit #N of M — NO edits were written to disk` instead of returning a preview that looks like a partial success. The MCP tool result is the message followed by the JSON payload.
- `batch_apply_edits`: preview is padded to map 1:1 to the `edits` array — edits that were never reached get an `action: "error"` entry with `not evaluated — batch stopped at edit #N`.
- `batch_apply_edits`: `excludePatterns` parameter — when `replaceAll` is used with `excludePatterns`, occurrences inside excluded regions (e.g. `#[cfg(test)]` blocks) are skipped. Handles annotation-on-separate-line with 5-line lookahead for opening brace.
- `batch_apply_edits`: sequential validation in Phase 2 — each edit is re-validated against current file state (after previous edits) with rollback on failure. Phase 1 defers validation for chained edits on same file.
- `findEscapeReason()`: optional `cwd` parameter — when a command contains both `git -C`/`--git-dir`/`--work-tree` and a cd/pushd escape pattern, the function checks if the git path resolves inside `cwd` before flagging as escape. `safetyCheck()` now passes `cwd` to `findEscapeReason()`.
- 9 new tests (total 317, up from 308)
- 5 new tests for explicit `batch_apply_edits` outcome reporting (total 322)

### Changed
- `resolveFilePath()` multi-root fallback now triggers even when `cwd` is provided but the file doesn't exist at the resolved location. Scans all allowed roots for the relative path — 1 match auto-resolves, 2+ shows disambiguation error.
- `ALLOWED_ROOTS` now includes paths from `MCP_PROJECT_NAMES` (friendly project names). Projects registered only via `MCP_PROJECT_NAMES` and not via `MCP_EXTRA_ROOTS` are now recognised as allowed roots — fixes file-based tools failing to resolve paths for alias-registered projects.
- `run_command_grep`: catch block now extracts stdout/stderr from exec error object. Non-zero exit code with output returns matches instead of error.

### Fixed
- `batch_apply_edits`: sequential application — edit 2 can now find text created by edit 1 on the same file (was failing with "search string not found" because Phase 1 validated all edits against original file content).
- `batch_apply_edits`: `replaceAll` no longer breaks test code — use `excludePatterns: ["#[cfg(test)]"]` to skip test modules.
- `batch_apply_edits`: relative/absolute paths now resolve correctly when the target project is registered only via `MCP_PROJECT_NAMES` (was resolving against devkit root instead of project root).
- `batch_apply_edits`: partial rollback — when a chained edit fails, only files modified by the failed edit and subsequent edits are reverted. Files successfully modified by earlier edits are preserved (was: full atomic rollback lost all valid edits).
- `extract_code_block`: relative and absolute paths now resolve correctly for alias-registered projects (was returning "Cannot read file" for files within the project).
- `run_command_grep`: zero matches with non-zero exit code now returns empty result instead of error.
- `batch_apply_edits`: validation-failure response was ambiguous — the returned `preview` showed `action: "edit", matchCount: 1` for edits that had validated while no edit was written at all, so callers could not tell that the batch was a complete no-op. The response now states `VALIDATION FAILED on edit #N of M — NO edits were written to disk` plus machine-readable `appliedEdits`, `written`, `reverted`, `nothingWritten` and per-entry `applied`.
- `extract_code_block`: relative paths now resolve across all allowed roots even when `cwd` is provided.

### Known Limitations (documented)
- `batch_apply_edits`: same-file chain failures revert the entire file (can't partially undo changes to a single file).
- `run_safe_command`: 60s client-side timeout limit (MCP client, not server) — use `run_commands` tool for long-running commands.
- Windows `cmd.exe`: `;` is not a command separator — use `&` or separate tool calls.
- `universal_find_references`: symbols with special characters (colons, spaces) may fail when sent from certain MCP clients due to client-side JSON-RPC serialization issues.

## [0.1.1] - 2026-09-12

### Added
- Supported Languages section in README.md (Rust, TypeScript, Python, C++)
- Multi-root fallback for `resolveFilePath()`: relative paths without `cwd` now scan all allowed roots — unique match auto-resolves, multiple matches produce disambiguation error (6 new tests)
- 6 new tests for `resolveFilePath` multi-root fallback (total 300, up from 294)
- Tool Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) for all 17 tools per MCP spec
- `src/__tests__/tool-integration.test.ts` — 23 new tests covering `list_tools`, `help_tool`, `read_log_slice`, `list_allowed_roots`, `resolve_cwd`
- M8ven Trust Index badge in README.md
- Release automation script (`scripts/release.cjs`)
- Pre-commit hook: blocks sensitive files (.env, .key, .pem, etc.)
- Pre-push hook: gitleaks scan + path scanner for tracked files
- 7 refactoring tools (Phase 1–3):
  - `universal_find_references` — language-agnostic symbol search with optional role detection (declaration/import/usage)
  - `extract_code_block` — code block extraction with annotation-aware, string/comment-safe bracket matching
  - `split_file_by_declarations` — split large files into modules with index generation (mod.rs/index.ts/__init__.py)
  - `batch_apply_edits` — atomic multi-file edits with validation-first and rollback on failure
  - `generate_module_skeleton` — generate module files by extracting symbols from source
  - `verify_refactor_safety` — semantic diff with 5 checks (function count, signatures, exports, imports, comment ratio)
- `report_tool_feedback` — agent feedback tool for bugs, improvements, feature requests (writes to `.mcp/FEEDBACK.md`, idempotent, project-protected)
- `list_feedback` — list feedback entries with optional filters (type, tool, status)
- `close_feedback` — close feedback entries by ID with optional resolution text
- `list_tools` — lists all available MCP tools with markdown-formatted descriptions, filterable by category
- `help_tool` — detailed help for any tool including markdown parameter table
- `textResult()` / `jsonResult()` helpers in `src/format.ts` for consistent MCP response formatting
- Test fixtures (`src/__tests__/fixtures/`) with Rust, TypeScript, Python test data
- Bypass test suite: 14 tests documenting security heuristic coverage and known limitations (base64, variable indirection, encoded cd)
- Integration test suite (`src/__tests__/handlers.test.ts`): 7 tests verifying tool output format
- Shared `resolveFilePath()` helper in `src/safety.ts` — unified file path resolution with alias lookup + allowed roots validation for all file-based tools
- `cwd` parameter for `split_file_by_declarations`, `generate_module_skeleton`, and `batch_apply_edits` (relative path resolution)
- 6 new tests for `resolveFilePath()` (total 269, up from 263)
- 116 new tests (total 263, up from 147)
- Shared parsing helpers exported from `src/symbols.ts` (tokenizer, bracket matching, annotation detection)
- `tsconfig.json`: exclude test fixtures from compilation

### Changed
- `resolveFilePath()` now checks file existence on disk before falling back to scan other allowed roots — prevents silent misresolution when multiple projects share common filenames (e.g. `index.ts`, `README.md`)
- README.md: added `cwd` parameter to `extract_code_block` documentation, updated test badge to 300, described multi-root path resolution in `batch_apply_edits` and Typical workflow section
- PROJECT_CONTEXT.md: added language support entry, updated test count to 300
- `index.ts` refactored — extracted `src/commands.ts` (safetyCheck, executeCommand, executeGrep, resolveToolCwd) and `src/helpers.ts` (temp paths, audit log, line parsing); `index.ts` reduced from 1349 to 950 lines (-30%)
- Audit logging removed from `list_tools` and `help_tool` (discovery tools are now truly read-only)
- Upgraded `@modelcontextprotocol/sdk` from 1.29.0 to 1.30.0
- Refactored `extract_code_block` to use shared `resolveFilePath()` (replaced inline ad-hoc path resolution with safety validation)

### Fixed
- README.md: test count badge updated from 294 to 300
- Closed feedback: `batch_apply_edits` relative paths now resolve across allowed roots
- Closed feedback: `list_tools` raw JSON envelope — identified as Cline client display issue, not server bug
- `batch_apply_edits`: added `cwd` parameter + `resolveFilePath()` — now resolves relative paths (was returning "Cannot read file" for files in newly created subdirectories)
- `split_file_by_declarations` & `generate_module_skeleton`: multi-line `use`/`import` blocks now collected completely (was truncated at first line, breaking generated imports)
- `extract_code_block` & `split_file_by_declarations`: removed `#` → line comment handling from tokenizer — Rust `#[derive(...)]`/`#[allow(...)]` attributes no longer cause missing closing braces in extracted functions
- `split_file_by_declarations`: now includes top-level `use`/`import` statements in generated modules
- `split_file_by_declarations`: detects and appends `impl` blocks associated with extracted types (Rust)
- `split_file_by_declarations` & `generate_module_skeleton`: relative file paths now resolve correctly via shared `resolveFilePath()` helper (was returning "Cannot read file")
- `split_file_by_declarations`: finds private declarations (`fn`, `const`, `struct`) and `pub(crate)`/`pub(super)` items
- `generate_module_skeleton`: filters `extractCodeBlock` matches to declaration-only — no more garbled output from usage sites
- `generate_module_skeleton`: imports now only collected from top-level (no indented `use` statements)
- `split_file_by_declarations`: cross-module references now generate `use super::TypeName;` imports
- `split_file_by_declarations`: cfg-aware cross-module imports — wraps with `#[cfg(...)]` when symbol is only used in cfg-gated code, falls back to `#[allow(unused_imports)]`
- `split_file_by_declarations`: `mod` blocks (e.g. `#[cfg(test)] mod tests`) now extractable
- `batch_apply_edits`: multiple edits to same file now accumulate correctly (was overwriting previous edits)
- `batch_apply_edits`: CRLF line endings now handled — normalizes to LF for comparison, preserves original endings in output
- `extract_code_block`: added `cwd` parameter — relative paths now resolved against cwd or primary root
- `universal_find_references`: without `cwd`, now searches ALL allowed roots (was defaulting to primary root only)
- LICENSE restructured — standard GPL text first, project copyright as appendix

## [0.1.0] - 2026-09-08

### Added
- 6 MCP tools: `run_safe_command`, `run_destructive_command`, `read_log_slice`,
  `run_command_grep`, `list_allowed_roots`, `resolve_cwd`
- Safety layers: dangerous-pattern blacklist, directory-escape detection,
  write-target checks, destructive confirmation, missing target guard
- Output normalization: Windows UTF-8, ANSI stripping, redirect reporting
- GPL-3.0-or-later license (full text in LICENSE)
- 147 passing tests (vitest)
- Branch protection: linear history, force push blocked
- README badge shields (Version, License, Tests, Node.js)
- GitHub About: description, homepage, topics
