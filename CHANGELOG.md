# Changelog

All notable changes to `noshell-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-06-24

Internal hardening and docs. No change to tool behavior or the MCP wire contract.

### Changed
- Derive the `exec` and `pipeline` tool input types from their Zod schemas via
  `z.infer` instead of casting the handler input to hand-written interfaces. A
  new `src/schemas.ts` is the single source of truth: the same shapes feed
  `registerTool`'s `inputSchema` (runtime validation) and the consumed types, so
  the validated shape and the consumed type can no longer drift (the old
  `input as ExecInput` cast silenced the compiler and hid exactly that drift).

### Documentation
- Add `CLAUDE.md` with project working guidance.
- Add client-specific MCP config snippets to the README.

## [0.2.0] - 2026-06-24

### Added
- Process-tree termination on stage timeout: kill the whole child tree
  (POSIX process-group `SIGTERM`→grace→`SIGKILL` via negative pid; Windows
  `taskkill /T /F`) rather than just the direct child.
- In-flight child registry with shutdown reaping — `SIGINT`/`SIGTERM`/exit
  handlers force-kill any tracked child trees (solid on POSIX, best-effort on
  Windows).
- Expose `maxBytes` (per-stream output cap, default 1 MB) and `timeoutMs`
  (default 120 000 ms) in the `exec` and `pipeline` tool schemas.

### Changed
- Report the server's real version in the MCP handshake by reading it from
  `package.json` at runtime instead of hardcoding it.

[0.2.1]: https://github.com/dongray2/noshell/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/dongray2/noshell/compare/v0.1.3...v0.2.0
