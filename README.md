# QuietLSP

CWD-scoped LSP diagnostics filtering for Claude Code.

## What it solves

When several agent sessions or Git worktrees share one language-server environment, diagnostics from unrelated files can enter the wrong agent's context. QuietLSP sits between Claude Code and the real language server and filters `textDocument/publishDiagnostics` so a session receives diagnostics only for its own working directory and validated workspace roots.

```text
Claude Code
   |
   | language-server command on PATH
   v
QuietLSP shim
   |
   v
real typescript-language-server / rust-analyzer
```

QuietLSP does not modify project source files or server-side conversation data.

## Attach mechanism

Claude Code's language-server plugins currently resolve `typescript-language-server` and `rust-analyzer` by command name. QuietLSP therefore uses a PATH-shadowing shim rather than modifying plugin-cache files.

The default shim directory is `$HOME/.claude/bin` on Unix and `%USERPROFILE%\.claude\bin` on Windows. Override it with `QUIETLSP_SHIM_DIR` if your environment uses another directory that is earlier on PATH than the real language-server binary.

Do not install by editing `~/.claude/plugins/cache/**`: cache contents can be replaced by plugin updates and are not a reliable attachment point.

If a future Claude Code release stops resolving the server through PATH, the installer/attach mechanism will need to be re-qualified against that release.

## How filtering works

`quietlsp <real-binary> [args...]` launches the real language server and proxies LSP frames.

Client -> server traffic passes byte-for-byte except for the `initialize` request: `capabilities.textDocument.diagnostic` is removed so servers that support pull diagnostics continue using push `publishDiagnostics`, which QuietLSP can scope safely.

Server -> client traffic is parsed as Content-Length-framed JSON-RPC:

- diagnostics for files inside the session CWD pass;
- diagnostics for validated `workspaceFolders` roots pass;
- out-of-scope local-file diagnostics are dropped;
- virtual/remote/non-file URIs pass unchanged;
- a previously forwarded URI may receive one empty clear publication even after it becomes out of scope;
- malformed framing permanently fails open to raw passthrough rather than risking a broken LSP stream;
- a single valid frame containing unparseable JSON passes unchanged and filtering resumes afterward.

Diagnostic/capability events are logged beneath `${XDG_STATE_HOME:-~/.local/state}/quietlsp/` on Unix and `%LOCALAPPDATA%\quietlsp\` on Windows. Set `QUIETLSP_LOG` to override the exact log file.

## Install

Requirements:

- Node.js;
- Claude Code language-server feature;
- `typescript-language-server` and/or `rust-analyzer` installed on PATH.

Unix compatibility entrypoint:

```sh
./install-quietlsp
./install-quietlsp --status
```

Cross-platform canonical installer (including native Windows):

```text
node install-quietlsp.mjs
node install-quietlsp.mjs --status
```

On Windows the installer writes `.cmd` PATH shims; it does not require Bash or WSL.

The installer:

- resolves the real server while skipping its own shim directory;
- refuses to overwrite a foreign file;
- installs/refreshes only QuietLSP-owned shims;
- supports `--status` and `--uninstall`.

To use another shim directory:

```sh
QUIETLSP_SHIM_DIR="$HOME/.local/bin" ./install-quietlsp
```

That directory must appear before the real server binaries on PATH for Claude Code sessions.

## rustup proxy caveat

`rust-analyzer` may resolve to a `rustup` proxy rather than a standalone binary. Treat `command -v rust-analyzer` as discovery, not proof that the language server is usable; probe `rust-analyzer --version` and avoid wrapper chains that can rediscover their own shim through PATH.

The repository currently has fixture and installer coverage plus a live TypeScript-language-server integration test. A corresponding induced-diagnostic Rust integration fixture is still a named gap; see `docs/SPEC.md`.

## Test

```sh
node tests/filter.test.mjs
node tests/installer.test.mjs
bash tests/installer.test.sh   # Unix compatibility wrapper
node tests/integration.test.mjs
```

GitHub CI runs the framing/filtering, cross-platform installer, and a real `typescript-language-server` integration on both Ubuntu and native Windows.

The integration test skips honestly when `typescript-language-server` is not installed. If the language server cannot discover a TypeScript installation from the fixture workspace, set `QUIETLSP_TSSERVER_PATH=/absolute/path/to/typescript/lib/tsserver.js`. It never turns a missing dependency into a fake pass claim.

## Known limits

- QuietLSP is tied to Claude Code's current PATH-based language-server launch seam.
- The strongest real integration proof currently covers TypeScript. Rust analyzer detection is probed, but the full induced-diagnostic Rust case is not implemented yet.
- The final "two interactive Claude sessions no longer see each other's diagnostics" check requires an interactive Claude Code environment; the repository tests prove the filtering mechanism and real TypeScript server path directly.
