# noshell — shell-free exec MCP server

**Date:** 2026-06-24
**Status:** Approved design, pending implementation plan

## Problem

Agents (e.g. Claude Code) run programs through the `Bash` tool, which hands a
single command *string* to a shell (`bash`/`sh`, PowerShell/cmd on Windows).
That shell layer introduces a whole class of avoidable failures: heredoc
plumbing, word-splitting, glob expansion, `$VAR` interpolation, and quoting
bugs — especially with multi-line stdin, special characters, untrusted/dynamic
strings, and paths with spaces. None of this is intrinsic to running a program;
it is an artifact of going through a human-oriented shell.

The kernel's `execve()` already takes a fully explicit invocation: a program
path plus an **argv array**, with stdin as a separate byte stream. Passing argv
directly (`spawn(path, args, { shell: false })`) eliminates every shell-parsing
ambiguity above.

## Goal

A small, **shareable** stdio MCP server, `noshell`, that lets an agent invoke
programs with explicit argv and explicit stdin — no shell, ever. It does **not**
replace `Bash`; it sits alongside it. The agent prefers `noshell` for fragile
cases and falls back to `Bash` for interactive convenience (globs, ad-hoc
pipelines, things noshell doesn't cover). This is the deliberate "best of both
worlds" middle path.

Non-goals: replacing Bash, reimplementing a shell language, file
read/write/search (the built-in Read/Write/Edit/Grep/Glob tools already cover
those without a shell).

## Architecture

- Node.js / TypeScript stdio MCP server using the official
  `@modelcontextprotocol/sdk`.
- Exposes **two tools**, `exec` and `pipeline`, both delegating to one internal
  `runStage()` helper that calls `child_process.spawn(path, args, { shell: false })`.
- `shell: false` is non-negotiable and applied everywhere — argv is passed to the
  OS verbatim with no shell interpretation.
- Distributed for `npx noshell-mcp` install and `.mcp.json` registration.

The two-tool split (vs. one unified tool) is chosen so the tool *name* signals
intent and the common single-command case stays terse. Both share the internal
stage runner, so there is no real duplication.

## Tool 1 — `exec`

Run a single program with explicit argv.

```jsonc
// input
{
  "path": "grep",                       // required: program (PATH-resolved by spawn)
  "args": ["-rn", "needle", "src"],     // optional: argv (default [])
  "stdin": "optional string",           // optional: fed to the process stdin
  "cwd": "optional/working/dir",        // optional: default = server launch dir
  "env": { "KEY": "VALUE" },            // optional: MERGED over process.env (override, not replace)
  "timeoutMs": 120000                   // optional: default 120000
}
// output
{
  "code": 0,
  "stdout": "...",
  "stderr": "...",
  "timedOut": false,
  "truncated": false
}
```

## Tool 2 — `pipeline`

Chain stages, wiring each stage's stdout to the next stage's stdin in-process
(no temp files, no shell pipe). Explicit pipes without a shell.

```jsonc
// input
{
  "stages": [
    { "path": "cat",  "args": ["log.txt"] },
    { "path": "grep", "args": ["ERROR"] },
    { "path": "wc",   "args": ["-l"] }
  ],
  "stdin": "optional, fed to stage 0 only",
  "pipefail": true                       // optional: default true
}
// output
{
  "code": 0,                             // last stage's code (or first failing stage if pipefail)
  "stdout": "42\n",                       // last stage's stdout
  "stderr": "",                           // last stage's stderr
  "stages": [ { "code": 0 }, { "code": 0 }, { "code": 0 } ],
  "timedOut": false,
  "truncated": false
}
```

Each stage object accepts the same `path`, `args`, `cwd`, `env` fields as `exec`
(no per-stage `stdin` — stdin flows from the previous stage). `timeoutMs` applies
to the whole pipeline.

## Key behaviors / decisions

- **No shell, always.** `spawn(..., { shell: false })`. The single defining
  property of the project.
- **env merge semantics.** `env` is merged *over* `process.env` (override
  individual keys), never a wholesale replacement, so PATH etc. survive.
- **cwd default.** The server's launch directory if `cwd` is omitted.
- **Output caps.** stdout/stderr are captured as UTF-8 strings and truncated at
  **1 MB each** (configurable), setting `truncated: true`. Prevents a runaway
  command from blowing up the agent's context.
- **Timeouts.** Per-call `timeoutMs`, default **120 s**. On expiry the process
  (and pipeline children) are killed and `timedOut: true` is returned.
- **Errors are structured, not thrown.** Spawn failures (`ENOENT`, `EACCES`,
  etc.) return `{ "error": "ENOENT", "message": "..." }` so the agent can read
  and recover rather than seeing an exception.
- **`pipefail` (default true).** If any stage exits non-zero, the pipeline call
  reports failure with the first failing stage's code, like
  `set -o pipefail`. With `pipefail: false`, only the last stage's code matters.

## Windows tradeoff (accepted, documented)

With `shell: false`, Windows batch files (`.cmd` / `.bat`) will **not** run —
they require `cmd.exe`. `.exe` programs and scripts with a registered
interpreter run fine. This is an accepted consequence of being shell-free and
will be documented prominently in the README. Users needing `.cmd`/`.bat` use
the built-in `Bash` tool for those specific calls. No per-stage `shell` escape
hatch in v1 (would undermine the project's one guarantee).

## Steering — the "middle" policy

Ship guidance, **not** a Bash ban. The README provides a recommended `CLAUDE.md`
snippet and a sample `.mcp.json` registration:

> Prefer `noshell` `exec` / `pipeline` when a command involves multi-line stdin,
> special characters, untrusted or dynamically-built strings, or paths with
> spaces. Use `Bash` for interactive globs, convenience one-liners, and anything
> noshell doesn't cover (e.g. Windows `.cmd`/`.bat`).

We do **not** add `permissions.deny: ["Bash"]` — keeping both tools available is
the whole point of the middle approach. Users who want the strict version can
add the deny themselves.

## Testing

- **Unit tests** (Vitest) against `runStage()`: exit codes, stdin delivery,
  env-merge semantics, timeout kill, output truncation, structured spawn errors.
- **Integration tests** driving `exec` and `pipeline` through real binaries
  (`cat` / `grep` / `wc` on POSIX; documented Windows equivalents).
- **No shell is invoked anywhere in the tests** — that property is itself part
  of what we verify.

## Packaging

- Published as `noshell-mcp` (name TBD-on-availability), installable via
  `npx noshell-mcp`.
- README documents: install, `.mcp.json` registration block, the CLAUDE.md
  policy snippet, the two tool schemas, and the Windows `.cmd`/`.bat` caveat.

## Out of scope (v1)

- Replacing Bash or implementing shell syntax.
- Per-stage `shell: true` escape hatch.
- File read/write/search tools (covered by built-in agent tools).
- Background/long-running process management, TTY/interactive programs.
