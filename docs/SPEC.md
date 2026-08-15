# QuietLSP — cwd-scoped LSP diagnostics filter

audience: AI coding agents first. Spec = contract; implementer owns bodies.
v1 shipped 2026-08-15; v1.1 amendments below fold in the external review (gpt-5.6-sol, log 20260815-213926) — findings referenced as R1..R12.

## Purpose

Claude Code's language-server feature injects `new-diagnostics` blocks into agent context with no per-file scoping — sessions receive TypeScript/Rust errors from OTHER worktrees and other sessions' half-finished edits (measured 2026-08-15; harness v2.1.233 offers only per-language on/off). QuietLSP sits between the plugin and the real language server and drops diagnostics for files outside the session's working tree. Sibling product to QuietContext: same mission (protect agent context), adjacent layer.

## Non-goals

- Never MODIFY files inside the plugin cache. **Attach point corrected 2026-08-15** — the earlier "v1 attach (verified)" claim in this section (Claude Code prepending `~/.claude/plugins/cache/claude-plugins-official/<plugin>/<version>/bin` to PATH) was wrong: direct `/proc/<pid>/environ` inspection of live `typescript-language-server` processes showed that PATH entry present in only 1 of 3 running instances, explainable as an artifact of that session's own shell profile, and absent even from a process spawned after a plugin-cache shim was installed. Not a reliable interception point — see README "Attach mechanism" for the full investigation. The actual, confirmed attach point is `$HOME/.claude/bin`, which is first on PATH in every sampled session including two that spawned `/usr/local/bin/typescript-language-server` directly with no shim anywhere in the chain. On this box `~/.claude/bin` is itself a deploy-managed symlink (Overdeck's `packaging/deploy-local.sh` convergence) — the durable shim source lives in that repo (`modules/workstation/claude/bin/`), not written here at install time; this repo's `install-quietlsp` remains useful for local/manual installs and `--status` auditing but is not the durable mechanism on a deploy-managed box.
- No severity filtering, no dedup. Message REWRITING is permitted in exactly one place: the capability rewrite in R1 below.
- Not a general LSP proxy framework.

## Architecture

```
claude-code plugin ──PATH──> quietlsp shim ──spawns──> real language server
   client→server: passthrough EXCEPT the initialize capability rewrite (below)
   server→client: parse LSP framing; filter diagnostics; pass all else
```

### Diagnostics model — push vs pull (R1, CRITICAL)

rust-analyzer switches from push `publishDiagnostics` to PULL (`textDocument/diagnostic`, LSP 3.17) when the client advertises `textDocument.diagnostic`; a publish-only filter does nothing in pull mode. v1.1 contract: the wrapper parses the client's `initialize` request and REMOVES `textDocument.diagnostic` from advertised capabilities, forcing push mode for every server — the one sanctioned client→server mutation (Content-Length recomputed for that frame only). The wrapper logs the original and rewritten capability sets once per session. If a future harness requires pull mode, the alternative (filter pull responses by request-ID correlation) becomes a new slice — not silently absent.

### Scope rule

- Root: captured ONCE at startup — wrapper cwd, canonicalized (symlinks resolved). The wrapper records root + the client's `rootUri`/`workspaceFolders` from initialize to the log; if `rootUri` disagrees with cwd, the wrapper prefers cwd (session identity) and logs the disagreement (R3: evidence, not assumption).
- Eligible for filtering: local `file:` URIs only (percent-decoded, empty/localhost authority). `untitled:`, virtual, remote schemes pass unchanged (R4).
- Containment: component-based path-prefix against the canonical root; nonexistent paths resolve through their deepest existing canonical ancestor (R4).
- Out-of-root but legitimate documents (project references, generated sources): v1.1 additionally ALLOWS any root listed in the client's initialize `workspaceFolders` (validated: must exist, be a directory). Extra-roots config file stays roadmap (R5 — partial promotion).

### Clear-state correctness (R6)

`publishDiagnostics` is state REPLACEMENT; an empty array is how a server clears. The wrapper keeps a per-URI forwarded-set: an out-of-scope publication is dropped UNLESS that URI has a previously-forwarded publication, in which case an EMPTY publication passes (clearing stale client state) and the URI leaves the set. The `version` field is never altered. Test the allowed→denied→clear transition.

## Fail-open contract (R7 — split)

- FRAMING loss (invalid/absent Content-Length, damaged header, wrapper-wide I/O error) → permanent byte-passthrough for the rest of the stream + one log line: frame boundaries are untrustworthy.
- Valid frame, unparseable/unclassifiable JSON → pass THAT frame unchanged, resume filtering at the next frame (boundaries still trustworthy). Buffered bytes are emitted exactly once.
- Shutdown (R11): single ordered writer per direction; at most one declared body buffered; client EOF → close child stdin; drain child stdout before exit; exit with child's code (signal death → 128+n); forward TERM/INT/HUP; hard deadline 5s from child exit to wrapper exit.

## Installer contract (`install-quietlsp`)

- Idempotent; discovers ALL plugin version dirs; re-run after every plugin update.
- Atomicity (R8): validate every target BEFORE any write; per-target atomic install (write temp + rename); refuse on collisions (existing foreign shim, nested wrapper); record per-target hashes + mode metadata under ~/.local/state so uninstall provably restores/removes exactly what was installed.
- `--status` (R9): `wrapped` = full tuple — recognized plugin/version, shim present + hash matches repo copy, real server resolvable, shim launch probe succeeds. Anything else recognized = `drifted`; pristine = `unwrapped`. Exit non-zero unless all wrapped.
- `--uninstall`: removes only recorded installs.
- Unknown/indeterminate layout → refuse loudly, wrap nothing.

## Test strategy

- Framed-stream fixtures: in-tree pass byte-exact; out-of-tree drop; clear-state transition; capability rewrite of initialize (and only initialize); per-frame parse-fail recovery vs framing-loss permanent passthrough; chunk-boundary reassembly.
- Integration (R10): against the INSTALLED typescript-language-server — record negotiated capabilities, induce a real diagnostic in-tree and in a sibling worktree, assert the sibling's is dropped and the in-tree one arrives, assert unrelated traffic byte-identical. **rust-analyzer gap corrected 2026-08-16: a functional binary DOES exist on this box (`/usr/bin/rust-analyzer` 1.95.0) — the earlier "non-functional" conclusion sampled only `~/.cargo/bin/rust-analyzer` (a rustup toolchain proxy) and mischaracterized it, see README "rustup proxy footgun".** `RUST_ANALYZER_FUNCTIONAL` in `tests/integration.test.mjs` already detects this correctly (the proxy's `--version` transparently falls back and passes). Still gapped, narrower now: the induced-diagnostic driveSession case itself isn't wired for rust-analyzer (needs a real Cargo project per fixture dir, not a loose file, and `rust-analyzer`'s own internal `cargo` resolution collided with this box's remote-build-offload `cargo` PATH shim during a bounded attempt — not chased further this session, needs its own pass).
- Installer: idempotency, all three --status verdicts, uninstall restores recorded state.

## Acceptance (v1.1 done =)

1. `--status` clean on this workstation.
2. Integration test above green and SAVED as a rerunnable artifact in tests/ (R12 — proof is a test, not an attestation).
3. Capability rewrite verified in the recorded initialize exchange.
4. Cross-worktree noise absence in an interactive session remains the operational check (owner-observed; cannot be produced by dispatched sessions) — checklist item, not acceptance.

## Roadmap (owner-gated)

- Pull-diagnostics filtering by request-ID correlation (if a harness ever requires pull mode).
- Extra allowed-roots config; fleet drift-audit wiring; publication.
