# QuietLSP — cwd-scoped LSP diagnostics filter

Status: v1.1 shipped; this document is the implementation contract.

## Purpose

Claude Code language-server diagnostics can cross session/worktree boundaries when several sessions share the same server environment. QuietLSP proxies the language server and drops local-file diagnostics outside the session's working tree while preserving unrelated LSP traffic.

## Non-goals

- Do not modify Claude Code plugin-cache files.
- No severity filtering or diagnostic deduplication.
- Message rewriting is permitted only for the `initialize` capability adjustment below.
- Not a general-purpose LSP proxy framework.

## Attach contract

Current supported seam: Claude Code resolves the language-server command through PATH. The installer shadows `typescript-language-server` / `rust-analyzer` in `QUIETLSP_SHIM_DIR` (default `$HOME/.claude/bin`) and resolves the real executable later on PATH.

A runtime that bypasses PATH requires a separately qualified attach mechanism; never silently claim interception when the launch seam changed.

## Architecture

```text
Claude Code --PATH--> QuietLSP shim --spawn--> real language server
 client -> server: pass through except initialize capability rewrite
 server -> client: parse frames, filter diagnostics, pass everything else
```

### Push vs pull diagnostics

Some servers switch to pull diagnostics when the client advertises `textDocument.diagnostic`. QuietLSP removes that capability from the client `initialize` request, recomputes Content-Length for that frame, and logs original/rewritten capabilities. Every other well-formed client frame passes byte-identical.

If a future client/server combination requires pull mode, filtering pull responses by request correlation is a separate feature and must be implemented/tested explicitly.

### Scope

- Capture and canonicalize wrapper CWD once at startup.
- Record `rootUri`/`workspaceFolders`; CWD remains the primary session identity.
- Add validated existing-directory `workspaceFolders` as allowed roots.
- Filter only local `file:` URIs. Virtual, untitled and remote schemes pass unchanged.
- Path containment is component-based, not string-prefix based.
- Nonexistent paths canonicalize through the deepest existing ancestor.

### Clear-state correctness

`publishDiagnostics` replaces state. Track URIs that have been forwarded. An out-of-scope publication is dropped unless it is an empty clear for a URI whose earlier diagnostic was forwarded; in that case the clear passes once and the URI leaves the set.

### Fail-open contract

- Invalid/missing Content-Length, damaged framing, or wrapper-wide framing loss -> permanent raw passthrough plus one log event.
- Valid frame with unparseable/unclassifiable JSON -> pass that frame unchanged, then resume filtering.
- Buffered bytes are emitted exactly once.
- Client EOF closes child stdin.
- Child stdout drains before wrapper exit.
- Child exit code/signals propagate; shutdown has a bounded drain deadline.

## Logging

Default:

```text
${XDG_STATE_HOME:-~/.local/state}/quietlsp/quietlsp.log
```

`QUIETLSP_LOG` overrides the destination. Logging failure must never break the language-server stream.

## Installer contract

- Idempotent.
- Skip its own shim directory when resolving the real server.
- Validate targets before replacement.
- Install per target through temp-file + rename.
- Refuse to overwrite foreign files.
- `--status` distinguishes wrapped/drifted/unwrapped and exits nonzero when a discovered target is not wrapped correctly.
- `--uninstall` removes only QuietLSP-owned shims.
- Unknown/indeterminate state fails loudly rather than overwriting it.

## Test strategy

Fixture tests cover:

- in-tree pass, out-of-tree drop;
- clear-state transitions;
- `initialize` capability rewrite only;
- frame parse failure vs permanent framing fail-open;
- chunk-boundary reassembly;
- path/URI containment.

Installer tests cover idempotency, status verdicts, collision refusal and uninstall in a throwaway sandbox.

Integration test uses a real installed `typescript-language-server`: induce in-tree and sibling diagnostics, prove sibling diagnostics are dropped by QuietLSP, and prove unrelated response data is unchanged.

### Named Rust gap

The test suite probes whether a functional `rust-analyzer` is available, but it does not yet drive a complete Cargo-project fixture through the same induced in-tree/sibling-diagnostic scenario. Therefore full Rust integration is not claimed.

## Acceptance

1. Fixture tests green.
2. Installer tests green.
3. Real TypeScript integration green when the server dependency is available; otherwise reported as SKIP.
4. Capability rewrite observed in the integration log.
5. Public source contains no machine-specific deployment/topology assumptions.

## Roadmap

- Full Rust induced-diagnostic integration fixture.
- Pull-diagnostics filtering if required by a future supported client/server combination.
- Optional extra allowed-root configuration if workspaceFolders are insufficient.
