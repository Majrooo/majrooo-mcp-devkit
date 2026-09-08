# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
- Test fixtures (`src/__tests__/fixtures/`) with Rust, TypeScript, Python test data
- 66 new tests (total 213, up from 147)
- Shared parsing helpers exported from `src/symbols.ts` (tokenizer, bracket matching, annotation detection)
- `tsconfig.json`: exclude test fixtures from compilation

### Fixed
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
