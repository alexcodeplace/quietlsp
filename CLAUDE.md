# Agent instructions — quietlsp

What this is: a cwd-scoped filter that sits between Claude Code's
`typescript-lsp`/`rust-analyzer-lsp` plugins and the real language server,
dropping `textDocument/publishDiagnostics` for files outside the session's
own working tree. Full detail: `README.md`.

- NEVER hand-edit anything under `~/.claude/plugins/cache/**` that the
  plugin itself tracks (README.md, LICENSE, etc.) — an update silently
  reverts it. This repo's installer only ever adds a new, untracked
  `bin/` directory per plugin version dir; it never touches a tracked file.
- Test: `/usr/bin/node tests/filter.test.mjs && bash tests/installer.test.sh &&
  /usr/bin/node tests/integration.test.mjs` — use the real node binary by
  absolute path; a PATH shim on this box redirects `node` to a remote build
  runner that requires a `package.json`/lockfile this repo doesn't have.
  `integration.test.mjs` drives the real installed `typescript-language-server`
  (skips itself, loudly, if that binary isn't present); it also probes for a
  functional `rust-analyzer` binary and reports a named gap if only the
  non-functional `rustup` proxy stub exists.
- Install: `./install-quietlsp`. Re-run it after every plugin version bump —
  a bump creates a new version dir with no `bin/` of its own.
- Local commits are the landing mechanism for this repo (no CI/PR gate here
  yet). Terse imperative commit messages, no co-author trailer.
