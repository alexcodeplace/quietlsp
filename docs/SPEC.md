# QuietLSP — cwd-scoped LSP diagnostics filter

audience: AI coding agents first. Spec = contract; implementer owns bodies.

## Purpose

Claude Code's language-server feature injects `new-diagnostics` blocks into agent context with no per-file scoping — sessions receive TypeScript/Rust errors from OTHER worktrees and other sessions' half-finished edits (measured 2026-08-15: hundreds of irrelevant lines per interactive session, ×~50 sessions; harness v2.1.233 offers only per-language on/off). QuietLSP sits between the plugin and the real language server and drops diagnostics for files outside the session's working tree, so the harness never receives the noise. Sibling product to QuietContext: same mission (protect agent context), adjacent layer (editor diagnostics vs command output).

## Non-goals

- Never edit the plugin cache (`~/.claude/plugins/...`) — updates silently revert hand edits (proven 2026-08-15, security-plugin incident). QuietLSP attaches to what the plugin EXECUTES.
- No severity filtering, no message rewriting, no diagnostics dedup in v1 — drop-or-pass whole notifications only.
- Not a general LSP proxy framework. One job.

## Architecture

```
claude-code plugin ──spawns──> quietlsp (wrapper) ──spawns──> real language server
   client→server bytes: passthrough, untouched, unbuffered
   server→client bytes: parse LSP framing; drop out-of-tree publishDiagnostics; pass all else
```

- Attach mechanism: discovered by investigation (bundled binary per plugin version dir / PATH lookup / absolute path). Wrapper shape follows `install-headless-guard`'s rename-real+shim pattern for whichever point the plugin executes. The investigation result is recorded in README with evidence.
- Scope rule: a `textDocument/publishDiagnostics` notification is DROPPED iff its `uri` resolves outside the wrapper process's cwd subtree (session cwd = the session's worktree). Symlinks resolved before comparison. Everything else — all requests, responses, other notifications — passes byte-identical.
- Framing: LSP = Content-Length-framed JSON-RPC over stdio. Passed messages keep their original bytes; dropped messages are removed whole (no mutation → no Content-Length recompute except omission).

## Fail-open contract (load-bearing)

Any framing/parse error, or any internal wrapper error → permanent byte-passthrough for the remainder of the stream + ONE log line to `~/.local/state/overdeck/quietlsp.log`. A broken LSP is worse than noisy diagnostics. The wrapper must never delay shutdown: real server exit → wrapper exits with same code; signals forwarded.

## Installer contract (`install-quietlsp`)

- Idempotent: re-run after every plugin update; discovers ALL plugin version dirs and wraps each (updates create NEW version dirs — both must be wrapped, per the 2.0.6/2.0.7 lesson).
- `--status`: per discovered server binary → `wrapped` / `unwrapped` / `drifted` (wrapper present but stale vs repo copy). Exit non-zero if any target is not `wrapped`.
- `--uninstall`: restores originals exactly.
- Covers TypeScript AND rust-analyzer plugins. Unknown/indeterminate plugin layout → refuse loudly, wrap nothing (fail-closed on install, fail-open on traffic).

## Test strategy

- Framed-stream fixture: in-tree diagnostics pass byte-exact; out-of-tree dropped; interleaved messages keep valid framing; malformed frame → passthrough mode from that point; large message split across chunk boundaries reassembled correctly.
- Handshake: real language server through the wrapper completes `initialize` and responds.
- Installer: run-twice idempotency; `--status` verdicts for all three states; `--uninstall` restores byte-identical originals.

## Acceptance (v1 done =)

1. Installed on this workstation, both language servers wrapped, `--status` clean.
2. LSP still functional through the wrapper (handshake proof).
3. An interactive session in worktree A no longer receives diagnostics for files in worktree B (owner/orchestrator verifies — dispatched subagents cannot activate the LSP feature).
4. Repo private on GitHub, tests green, README documents the attach mechanism and the re-run-after-update step.

## Roadmap (post-v1, owner-gated)

- Config file for extra allowed roots (monorepo sessions legitimately watching siblings).
- Drift audit wired into the fleet check pass alongside install-headless-guard.
- Publication (public repo / marketplace) — owner decision, not a lane's.
