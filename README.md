# noshell-mcp

A shell-free exec MCP server. It runs programs with an **explicit argv array** and
**explicit stdin** — never through `bash`/`sh`/PowerShell. That removes an entire
class of failures: heredoc plumbing, word-splitting, glob expansion, `$VAR`
interpolation, and quoting bugs. It does **not** replace your agent's `Bash`
tool; it sits alongside it for the cases where shell parsing is fragile.

## Install / register

Add to your `.mcp.json` (or Claude Code MCP config):

```json
{
  "mcpServers": {
    "noshell": {
      "command": "npx",
      "args": ["-y", "noshell-mcp"]
    }
  }
}
```

## Recommended CLAUDE.md policy (the "middle" approach)

This keeps `Bash` available and steers the agent to `noshell` only where it helps:

```markdown
## Running programs
Prefer the `noshell` tools (`mcp__noshell__exec` / `mcp__noshell__pipeline`) when a
command involves multi-line stdin, special characters, untrusted or dynamically
built strings, or paths with spaces. Use `Bash` for interactive globs, convenience
one-liners, and anything noshell doesn't cover (e.g. Windows `.cmd`/`.bat` files).
```

We deliberately do **not** ship a `permissions.deny: ["Bash"]`. If you want the
strict version, add that to your own settings.

## Tools

### `exec`
Run one program.

| field | type | default | notes |
|-------|------|---------|-------|
| `path` | string | — | program to run (PATH-resolved) |
| `args` | string[] | `[]` | argv **after** the program name |
| `stdin` | string | — | fed to the process stdin |
| `cwd` | string | server launch dir | working directory |
| `env` | object | — | **merged over** the server env, not a replacement |
| `timeoutMs` | number | `120000` | killed on expiry |

Returns `{ code, stdout, stderr, timedOut, truncated }`, or
`{ error, message, ... }` if the program can't be spawned.

### `pipeline`
Chain stages; each stage's stdout becomes the next stage's stdin (in-process,
buffered, no temp files, no shell pipe).

| field | type | default | notes |
|-------|------|---------|-------|
| `stages` | array of `{path, args?, cwd?, env?}` | — | at least one stage |
| `stdin` | string | — | fed to stage 0 only |
| `pipefail` | boolean | `true` | fail on first non-zero stage |
| `timeoutMs` | number | `120000` | budget for the whole pipeline |

Returns `{ code, stdout, stderr, stages, timedOut, truncated }`.

## Limits & caveats

- **Output cap:** stdout/stderr are truncated at 1 MB each; `truncated: true` flags it.
- **Windows `.cmd`/`.bat` are not supported.** Because `noshell` never uses a shell,
  Windows batch shims (which require `cmd.exe`) won't run. `.exe` programs and
  scripts with a registered interpreter are fine. Use `Bash` for `.cmd`/`.bat`.
- **No interactive/TTY programs** and no background process management in this version.

## Development

```bash
npm install
npm test        # vitest
npm run build   # tsc -> dist/
```
