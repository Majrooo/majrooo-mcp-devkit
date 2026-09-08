# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Release automation script (`scripts/release.cjs`)
- Pre-commit hook: blocks sensitive files (.env, .key, .pem, etc.)
- Pre-push hook: gitleaks scan + path scanner for tracked files

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
