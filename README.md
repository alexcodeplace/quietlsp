# QuietLSP

cwd-scoped LSP diagnostics filter for Claude Code.

## What it is

Claude Code's language-server feature (`typescript-lsp`, `rust-analyzer-lsp`
plugins) streams every `textDocument/publishDiagnostics` notification from
the language server into agent context, unscoped — a session working in one
worktree gets TypeScript/Rust errors from every other worktree's half-edited
files too. QuietLSP sits between the plugin and the real language server and
drops diagnostics for files outside the session's own working directory, so
the noise never reaches Claude Code core. Sibling project to
[quietmode](../quietmode) (QuietContext): same mission — protect agent
context — adjacent layer (editor diagnostics vs command output).

## Attach mechanism (investigation result, corrected 2026-08-15)

Neither `typescript-lsp` nor `rust-analyzer-lsp` bundles a server binary —
their plugin dirs contain only `README.md`/`LICENSE`, and the README tells
the user to `npm install -g typescript-language-server` /
`rustup component add rust-analyzer` themselves. The actual language server
is resolved as a **bare command name on PATH** at spawn time
(`typescript-language-server`, `rust-analyzer`), not a bundled binary and not
an absolute path baked into plugin config. That part held up.

**An earlier version of this doc claimed Claude Code prepends
`~/.claude/plugins/cache/claude-plugins-official/<plugin>/<version>/bin` to
PATH specifically for LSP spawns, and shimmed there. That claim was wrong,**
caught by checking `/proc/<pid>/environ` for live `typescript-language-server`
processes: only 1 of 3 running instances had that directory in `PATH`, the
other 2 (including one spawned *after* the plugin-cache shim was installed)
had the plain system PATH with no plugin-bin entry at all. The 1-of-3 case
was an artifact of that particular session's shell PATH carrying unrelated
plugin-bin entries (`code-review/bin`, `feature-dev/bin`, etc.) from its own
terminal setup — not something Claude Code's core constructs per LSP spawn.
Shimming inside the plugin cache does not reliably intercept anything.

**What IS reliable:** `$HOME/.claude/bin` is first on `PATH` in every sampled
session — including both processes that spawned
`/usr/local/bin/typescript-language-server` directly with no shim anywhere
in the chain — and in a fresh login shell. QuietLSP shadows the real command
names there (`~/.claude/bin/typescript-language-server`,
`~/.claude/bin/rust-analyzer`), the same house pattern already used for
`node`/`pnpm`/`npm`/`vitest`/`tsc` (see `~/.claude/bin/_cpu-guard-shim.sh`
for the sibling family — this repo does not touch that script or its
symlinks, it only adds two new, independent files next to them).

This is also why QuietLSP never touches anything under
`~/.claude/plugins/cache` — a plugin update silently reverts hand edits to
files it tracks (proven 2026-08-15 on the `security-guidance` plugin), and
in any case that tree is no longer the attach point.

**Known residual gap:** if a future plugin update starts bundling its own
server binary at an absolute path outside PATH resolution, this shim stops
applying and the installer needs a new attach point re-derived the same way
(inspect `/proc/<pid>/environ` and the real spawn chain of a running server,
don't infer from a single session's PATH).

**Durability, box-specific (2026-08-15):** on this machine `$HOME/.claude/bin`
is itself a deploy-managed symlink into an Overdeck deploy clone — anything
`install-quietlsp` writes there directly holds only until the next
`packaging/deploy-local.sh` convergence, then reverts. The durable copy on
this box is the shim source landed in the Overdeck repo
(`modules/workstation/claude/bin/`, deploy-installed there). `install-quietlsp`
and `--status` still work for a local/manual install or for auditing what's
on disk right now; they are not what makes the shim survive a deploy.

## Files

- `quietlsp` — the wrapper. `quietlsp <real-binary-absolute-path> [args...]`.
  Spawns the real binary. Client→server bytes pass through as original
  frame bytes except the client's `initialize` request, which has
  `capabilities.textDocument.diagnostic` stripped (forces push-mode
  diagnostics; Content-Length recomputed for that one frame). Server→client
  bytes are parsed as Content-Length-framed JSON-RPC; a
  `textDocument/publishDiagnostics` whose `file:` `uri` resolves outside the
  session's cwd (or a validated `workspaceFolders` root) is dropped, except
  an already-empty clear for a previously-forwarded uri, which passes once.
  A framing error → permanent raw passthrough for the rest of the stream; an
  unparseable single frame → that frame passes, filtering resumes at the
  next. One log line each for the capability rewrite, any `rootUri`/cwd
  disagreement, and any framing error, to
  `~/.local/state/overdeck/quietlsp.log`.
- `install-quietlsp` — idempotent installer. Resolves each command's real
  binary on `$HOME/.claude/bin` (skipping its own shim dir during the
  search), validates every target before writing any of them, and
  writes/refreshes a shim there. Local/manual install and `--status` audit
  tool — see "Durability" above for why it is not the durable mechanism on a
  deploy-managed box.
  - `install-quietlsp` — install/repair.
  - `install-quietlsp --status` — per-target `wrapped` / `UNWRAPPED` /
    `DRIFTED` (content mismatch OR a failed launch probe); exits non-zero
    unless everything is `wrapped`.
  - `install-quietlsp --uninstall` — removes only shims this tool installed.
- `tests/filter.test.mjs` — framed-stream fixture tests for the wrapper.
- `tests/installer.test.sh` — installer idempotency and `--status` verdict
  tests, run entirely inside a throwaway sandbox.
- `tests/integration.test.mjs` — drives a real session against the installed
  `typescript-language-server`; skips itself (loudly) if that binary isn't
  present. For `rust-analyzer`, detects a functional binary correctly
  (`/usr/bin/rust-analyzer` on this box) but has no induced-diagnostic
  driveSession case wired for it yet — named gap, see SPEC.md R10.

### `rustup` proxy footgun (found 2026-08-16)

`~/.cargo/bin/rust-analyzer` is usually a `rustup` toolchain proxy, not a
real binary — `readlink -f` lands on `rustup` itself. **Do not conclude
"rust-analyzer not installed" from that proxy alone**: when the active
toolchain lacks the `rust-analyzer` component, the proxy prints
`info: 'rust-analyzer' is unavailable for the active toolchain` to stderr
and then, on this box, transparently falls back to a real binary elsewhere
on `PATH` (`/usr/bin/rust-analyzer`) for at least `--version` and `--help` —
exit 0, real output. Always check for a real binary elsewhere on `PATH`
(`which -a rust-analyzer`) before concluding it's absent.

**More importantly:** that fallback is itself PATH-based — the proxy does
its own search for the next `rust-analyzer` on PATH, not a fixed path to
`/usr/bin`. If a shim sits on PATH ahead of the real binary (exactly the
`~/.claude/bin` attach point this repo uses), the proxy's fallback search
finds *that shim* instead — confirmed as a real, reproducible infinite fork
loop (the proxy re-invokes the shim, which re-resolves and can land on the
proxy again). `_quietlsp-shim.sh` in the Overdeck repo handles this two
ways: it never treats a candidate that resolves to a binary literally named
`rustup` as usable (validated or fallback), and it strips its own directory
from `PATH` before spawning any subprocess (probe or real exec), so even an
unrelated future proxy with the same habit can't rediscover the shim.

## Re-run after a plugin version bump

A plugin update creates a new `<plugin>/<new-version>/` dir with no `bin/`.
Run `install-quietlsp` again — it discovers and wraps every version dir it
finds, old and new, and leaves already-current shims untouched.

## Test

```
/usr/bin/node tests/filter.test.mjs
bash tests/installer.test.sh
/usr/bin/node tests/integration.test.mjs
```

(Use the real `/usr/bin/node`, not a PATH shim that redirects builds to a
remote runner — this repo has no `package.json`/lockfile for such a shim to
key off, so it will refuse to run.)

## Install

```
./install-quietlsp
./install-quietlsp --status
```

## Known gap

Diagnostics are only injected into an *interactive* Claude Code session with
the language-server feature active — a dispatched/subagent session never
activates it. So while the filter and installer are proven directly (fixture
tests + a live `initialize` handshake through the wrapper), the actual
owner-facing claim — "session A stops receiving diagnostics for files in
session B's worktree" — can only be observed from an interactive session.
That verification step is named, not faked; see the delivering agent's
report.
