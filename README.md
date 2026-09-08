# majrooo-mcp-devkit — Safe Command Runner

[![Version](https://img.shields.io/github/v/release/Majrooo/majrooo-mcp-devkit)](https://github.com/Majrooo/majrooo-mcp-devkit/releases)
[![License](https://img.shields.io/github/license/Majrooo/majrooo-mcp-devkit)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-192%20passing-brightgreen)](#)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-blue)](#)

> **Repository Access:** PUBLIC  
> **Version:** 0.1.0 · **Tests:** 192 passing · **License:** GPL-3.0-or-later

MCP server that provides safe command execution tools for Cline/Claude Desktop.

## Tools

### `run_safe_command`

Execute a shell command restricted to the active project root. Dangerous commands and writes outside the active root are automatically blocked. **This is the default tool** — always use this first.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `command` | string | — | Command to execute |
| `cwd` | string | primary root | Working directory (must be inside `MCP_PROJECT_ROOT` / `MCP_EXTRA_ROOTS`) |
| `maxLines` | number | 200 | Max output lines before truncation |
| `timeoutMs` | number | 60000 | Command timeout (1000–600000 ms) — raise for long jest/build runs |

### `run_destructive_command`

Execute a potentially dangerous command with explicit user confirmation. Only use when `run_safe_command` blocked the command **and** the user explicitly agreed after being informed of the specific risk.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `command` | string | — | Command to execute |
| `confirm` | boolean | false | Acknowledge the risk (required for dangerous commands) |
| `cwd` | string | primary root | Working directory (must be inside `MCP_PROJECT_ROOT` / `MCP_EXTRA_ROOTS`) |
| `maxLines` | number | 200 | Max output lines before truncation |
| `timeoutMs` | number | 60000 | Command timeout (1000–600000 ms) |

### `read_log_slice`

Read a portion of a previously saved log file. Use this instead of re-running a command with higher `maxLines`. Files are read directly via Node.js (not through the shell), so it also works for truncated logs in `os.tmpdir()`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `logPath` | string | — | Path to the log file |
| `startLine` | number | 0 | Starting line (0-based) |
| `lineCount` | number | 100 | Number of lines to read |

### `list_allowed_roots`

Return the registered roots configuration: the primary project (`MCP_PROJECT_ROOT`), all allowed roots (`MCP_EXTRA_ROOTS`, including globs), the concrete existing project directories under them (usable as `cwd`), and whether `MCP_BLOCK_CROSS_ROOT_READS` is enabled. Projects with a friendly name are returned as `{ path, name }` — in that case you can also use the name as `cwd`. **Call this before working in any non-primary project** to discover the exact `cwd` value to use. Runs no commands — it only reads configuration and lists directories.

No parameters.

### `resolve_cwd`

Verify whether a path (or a friendly project name from `MCP_PROJECT_NAMES`) is inside the allowed roots and get the exact `cwd` to use for commands. Pass the path you want to work in (e.g. your workspace folder) instead of guessing.

On success returns `{ ok: true, cwd, matchedRoot, exists, name? }`; on failure `{ ok: false, error, roots }`. `exists` tells whether the resolved directory actually exists on disk (relative `cwd` values are resolved against the primary project). Runs no commands — it only validates configuration.

| Parameter | Type | Description |
|---|---|---|
| `path` | string | Path to verify (absolute, e.g. the project workspace folder) |

### `run_command_grep`

Execute a command and return only lines matching a pattern (case-insensitive regex). Use instead of `run_safe_command` when you only care about specific lines (e.g., errors in build output). **This is the replacement for Unix `grep` on Windows** — filtering happens in-process, so `grep`/`head`/`tail` are not needed.

| Parameter | Type | Description |
|---|---|---|
| `command` | string | Command to execute |
| `pattern` | string | Regex pattern to filter lines (case-insensitive) |
| `cwd` | string | Working directory (default: primary root) |
| `timeoutMs` | number | 60000 | Command timeout (1000–600000 ms) — raise for long jest runs |

### `universal_find_references`

Find all occurrences of a symbol across a workspace. Returns structured output with file, line, column, context, and optional role annotations. Use this **before any refactoring session** to understand what will break when a symbol is renamed or moved.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `symbol` | string | — | Symbol to search for (word-boundary match) |
| `cwd` | string | primary root | Workspace root to search |
| `fileExtensions` | string[] | common source extensions | Restrict to these extensions |
| `excludePatterns` | string[] | `.git`, `node_modules`, `target`, ... | Directories to skip |
| `contextLines` | number | 1 | Lines of context around each match |
| `language` | string | — (disabled) | Optional: `"rust"`, `"typescript"`, `"python"`, or `"cpp"` — enables role detection (declaration/import/usage) |

### `extract_code_block`

Read the full text of a function, struct, class, or method from a file. Returns precise line range + content. Includes leading annotations (`#[derive]`, `@decorator`, `/// doc comments`). String/comment-aware bracket matching prevents false depth counts from braces inside strings or comments.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file` | string | — | Source file path (must resolve inside allowed root) |
| `symbol` | string | — | Symbol name to extract |
| `contextLines` | number | 0 | Extra lines before/after the block |

### `split_file_by_declarations`

Split a large file into multiple smaller files based on top-level declarations. Optionally generates a combining file (`mod.rs` / `index.ts` / `__init__.py`). Use `dryRun: true` (default) to preview the layout before writing.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `file` | string | — | Source file to split |
| `grouping` | object[] | — | `[{ module, symbols }]` — module groupings |
| `targetDir` | string | dirname(file) | Where new files are written |
| `language` | string | auto-detect | `"rust"`, `"typescript"`, `"python"`, `"cpp"` |
| `generateIndex` | boolean | true | Create combining file |
| `dryRun` | boolean | true | Preview only — write nothing |
| `overwrite` | boolean | false | Allow overwriting existing targets |

### `batch_apply_edits`

Apply multiple file edits atomically with rollback on failure. Validates all edits first — if any `search` string is not found or matches multiple times (without `replaceAll`), NO files are modified.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `edits` | object[] | — | `[{ file, search, replace, description?, replaceAll? }]` |
| `dryRun` | boolean | true | Preview all changes without writing |

### `generate_module_skeleton`

Generate a new module file with extracted symbols from a source file. Returns error with `unknownSymbols` list if any symbols are not found.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `modulePath` | string | — | Target file path |
| `symbols` | string[] | — | Symbol names to include |
| `sourceFile` | string | — | Original file to extract from |
| `language` | string | auto-detect | `"rust"`, `"typescript"`, `"python"` |
| `dryRun` | boolean | true | Preview only |
| `overwrite` | boolean | false | Allow overwriting existing file |

## Configuration

The server supports **one instance, many projects**. Projects are selected per command via the `cwd` parameter; the active project also acts as the "lockbox" for write/read checks.

| Env var | Description |
|---|---|
| `MCP_PROJECT_ROOT` | Primary project root (default `cwd` when omitted). If unset, the server's own directory is used (derived from the module location, **not** `process.cwd()`). |
| `MCP_EXTRA_ROOTS` | Additional roots, semicolon separated. |
| `MCP_PROJECT_NAMES` | Friendly names for projects, semicolon separated `path=name` pairs (see below). |
| `MCP_BLOCK_CROSS_ROOT_READS` | `1` or `true` → opt-in best-effort blocking of obvious reads outside the active root. |

Entry forms supported in both variables:

- **Plain path** `D:\W\TS\majrooo-mcp-devkit` → prefix: the directory itself **and everything below it** are allowed. Registering `D:\W` covers all projects under it.
- **Glob** `D:\W\TS\*` (`*`, `**`, `?`) → any path matching the pattern (and its subtree) is allowed.

Example — **one instance, many projects**, with friendly names:

```json
{
  "mcpServers": {
    "majrooo-mcp-devkit": {
      "command": "node",
      "args": ["D:\\W\\TS\\majrooo-mcp-devkit\\build\\index.js"],
      "env": {
        "MCP_PROJECT_ROOT": "D:\\W\\TS\\majrooo-mcp-devkit",
        "MCP_EXTRA_ROOTS": "D:\\W;D:\\python",
        "MCP_PROJECT_NAMES": "D:\\W\\TS\\cb=ZbaľSa;D:\\W\\TS\\nase-zasoby=Naše zásoby"
      }
    }
  }
}
```

`MCP_PROJECT_NAMES` maps a real project path to a readable name. This is useful when the folder name had to be shortened (e.g. Gradle path-length limits) or the project was renamed. The name can be used directly as `cwd` (e.g. `"cwd": "ZbaľSa"`), and `list_allowed_roots` will show such projects as `{ "path": "D:\\W\\TS\\cb", "name": "ZbaľSa" }`.

Switching projects is done via the `cwd` parameter, never via `cd` in the command. `cd ..`, `cd ~`, `cd C:\...`, and Windows `cd /d D:\...` are always rejected.

### Running tests / long commands (the anti-freeze workflow)

Never run test suites (`jest`/`npm test`), typecheck or builds through the Cline built-in terminal — it has no timeout and can freeze the whole window. Use the MCP tools instead:

1. Always pass the project's `cwd` (or friendly name, e.g. `"cwd": "ZbaľSa"`).
2. To filter output (e.g. jest summary), use `run_command_grep` — filtering happens in-process, so `cmd /c "... | findstr ... & echo DONE"` is **not needed and discouraged**:

```json
{
  "tool": "run_command_grep",
  "cwd": "ZbaľSa",
  "command": "npx jest src/app/__tests__/catalog.test.tsx 2>&1",
  "pattern": "Tests:|Test Suites:|FAIL|PASS|✕",
  "timeoutMs": 180000
}
```

3. For full output use `run_safe_command` with a small `maxLines` — the full output is saved to a temp log for `read_log_slice`:

```json
{
  "tool": "run_safe_command",
  "cwd": "ZbaľSa",
  "command": "npm run typecheck 2>&1",
  "maxLines": 100,
  "timeoutMs": 180000
}
```

4. If a run exceeds 10 minutes, run it in the background, redirect to a log file, and poll the log via `run_command_grep` — do not watch live terminal output.

### Typical workflow

1. Call `list_allowed_roots` to see the primary root, the allowed roots (including globs), and the concrete projects under them.
2. If you need to confirm a specific path, call `resolve_cwd` with your workspace folder — it returns the exact `cwd` to use and the matched root.
3. If the task targets a project other than the primary one, pass the resolved path as `cwd` on every command (`run_safe_command`, `run_destructive_command`, `run_command_grep`).
4. Otherwise, omit `cwd` — commands run in the primary root.

## Safety Mechanisms

| Layer | Description |
|---|---|
| **Registered roots** | `MCP_PROJECT_ROOT` / `MCP_EXTRA_ROOTS` define the allowed project registry (prefix or glob). `cwd` must match one of them. |
| **Directory restriction** | Commands execute with `cwd` set to the resolved project root. `cd ..`, `cd ~`, absolute-path `cd`, and Windows `cd /d` are rejected. |
| **Dangerous pattern detection** | Regex blacklist blocks destructive commands (`rm -rf`, `format`, `shutdown`, `git push --force`, fork bombs, pipe-to-shell, etc.). |
| **Write-target check** | Best-effort detection of writes outside the active root (`>`, `>>`, `2>`, `copy`, `move`, `mkdir`, `tee`, `curl -o`, ...). Writing from project A into project B is blocked even if B is registered — pick B via `cwd` instead. |
| **Cross-root read check (opt-in)** | `MCP_BLOCK_CROSS_ROOT_READS=1` blocks obvious reads outside the active root (`type`/`cat`/`Get-Content`/`git -C`/Node/Python path reads...). Best-effort heuristic. |
| **Explicit confirmation** | `run_destructive_command` requires `confirm: true` for dangerous commands. |
| **Missing destructive target** | A confirmed destructive command (`rmdir`/`del`/`erase`/`Remove-Item`) whose target does not exist in the active `cwd` is rejected with a "set the `cwd` parameter" message (reason `missing_destructive_target`) instead of a raw `The system cannot find the file specified`. |
| **Buffer & timeout limits** | 50 MB max output, 60-second timeout. |
| **Output truncation** | Long outputs are saved to `os.tmpdir()` for later inspection via `read_log_slice`. |
| **Audit log** | All executions logged to `os.tmpdir()/mcp-command-audit.log` (rotated to `.old` once it exceeds 5 MB). |

### Limitations

> The dangerous-pattern blacklist and the write/read target checks are **best-effort** layers, not security guarantees. Shell features (variables, command substitution, encoding) can bypass them. For production isolation use Docker/VM sandboxing.

## Windows Notes

- Commands run through `cmd.exe`. Unix-only tools (`grep`, `head`, `tail`, ...) **do not exist** — the server returns a friendly error with alternatives instead of a raw "not recognized" blob.
- Use `run_command_grep` instead of `grep`, and `read_log_slice` or PowerShell (`Get-Content out.log -TotalCount 30`) instead of `head`.
- Long-running processes (dev server, watch mode) exceed the 60s timeout — use the built-in terminal for those.

### Output normalization

On Windows the server automatically prefixes commands with `chcp 65001 > NUL &&` so the child process emits UTF-8 instead of the legacy OEM codepage (which would otherwise decode into U+FFFD replacement characters, e.g. around thousands separators in `dir` output). ANSI color codes from tools like vitest/jest are stripped as a fallback (`NO_COLOR=1` / `FORCE_COLOR=0` are also injected into the environment), and `read_log_slice` cleans ANSI codes defensively when reading older logs.

### Redirected output reporting

When a command redirects its output into a file (`npm test > test.log 2>&1`, `>> out.log`, `2> err.log`, ...), the response reports where the output went and shows the tail of the written file instead of an empty response or a bare `Command failed: ...`. On failure the response also includes the exit code (or timeout/signal) and the captured `stdout`/`stderr`. Discard targets (`NUL`, `/dev/null`), wildcard patterns and fd-duplication tokens (`2>&1`, `>&-`) are skipped; very large files are read only from the end.

## Agent Behavior Rules

The `.clinerules` file in the project root defines how AI agents should use these tools:

1. **Always try `run_safe_command` first** — never start with `run_destructive_command`.
2. **`run_destructive_command` only after explicit user confirmation** in the current conversation — general consent ("do what you need") is not sufficient.
3. **Never bypass `directory_escape` rejections** — no chaining, absolute paths, or cwd tricks. Use the `cwd` parameter to pick a registered project.
4. **Prefer `run_command_grep` / `read_log_slice`** over increasing `maxLines` for long output, and instead of Unix `grep`/`head`/`tail`.
5. **Use the built-in terminal only for quick interactive checks** (e.g., `git status`). Large-output commands (`npm install`, build, tests) must go through `run_safe_command`.
6. **Run tests before reporting task as complete**.

## License

This project is licensed under the GNU General Public License v3.0 or later - see the [LICENSE](LICENSE) file for details.

## Development

```bash
npm run build    # Compile TypeScript
npm test         # Run unit tests
npm run test:watch  # Watch mode
```

The server communicates over **STDIO** using the [Model Context Protocol](https://modelcontextprotocol.io).