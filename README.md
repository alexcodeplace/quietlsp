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

## First setup and everyday use

QuietLSP is useful when an agent working on your checkout is distracted by diagnostics from another project or worktree. It is not a code fixer: it narrows which **local-file diagnostics** reach that session while keeping in-scope errors visible.

Install the real language server first. For a TypeScript project, this normally means having both TypeScript and `typescript-language-server` available to the environment that launches Claude Code; for Rust, verify that `rust-analyzer --version` succeeds. Use Node.js 22 or newer for the same runtime generation exercised by this repository's CI.

```sh
git clone https://github.com/alexcodeplace/quietlsp.git
cd quietlsp
node install-quietlsp.mjs
node install-quietlsp.mjs --status
```

The Node installer also works in native Windows without Bash/WSL. Keep the clone at a stable path: the installed shims reference its `quietlsp` program and the resolved real server. Put the shim directory before the real server on the PATH inherited by **new** Claude Code sessions; the installer creates shims but does not rewrite your shell startup files or restart running sessions.

On Unix, check `command -v typescript-language-server`; on Windows use `where.exe typescript-language-server`. The first match should be the QuietLSP shim. `--status` identifies the owned shims; also verify the real server's version and launch a new Claude Code session from your project's own directory.

### Examples

- **Two worktrees:** open one new agent session from each worktree root. A diagnostic in worktree B should not appear in session A unless B is deliberately included in A's validated workspace roots.
- **A large TypeScript repository:** keep type errors in the active workspace visible while discarding unrelated local-file diagnostics. QuietLSP does not suppress all TypeScript warnings or change their severity.
- **A mixed workspace:** explicitly included workspace folders remain in scope. Do not mistake their retained errors for a broken filter; inspect the root configuration first.

There is no separate daily command after attachment: continue editing through Claude Code and let the shim proxy the language server. Diagnostic/capability logs use the platform-specific location below. For a controlled check, introduce an obvious type error in a disposable TypeScript fixture, confirm it remains visible in scope, and remove it afterward.

### Undo only QuietLSP

```sh
node install-quietlsp.mjs --uninstall
node install-quietlsp.mjs --status
```

The uninstaller removes only owned shims. Restore any PATH entry you added yourself, then use a new client session. Do not edit plugin caches or delete the real language server.

### Ask an agent to install and attach it

```text
Set up QuietLSP for my Claude Code projects using
https://github.com/alexcodeplace/quietlsp and its current README.
Inspect the OS, Node, client environment, existing PATH shims and real language
servers first. Clone to a stable location and use node install-quietlsp.mjs.
Preserve foreign shims and plugin caches. Ask before changing persistent PATH
or installing a missing language server. Verify --status and that a new
Claude Code process resolves the shim before the real server. Do not close or
restart my active sessions. Use a disposable TypeScript fixture to prove that
in-scope errors remain visible and unrelated local-file diagnostics are filtered;
report any interactive-client check that still needs me. Do not claim equivalent
Rust integration coverage. Show the final paths, daily workflow and owned-shim
uninstall command. Leave my project source and unrelated settings unchanged.
```

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
