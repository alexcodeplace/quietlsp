# Agent instructions — quietlsp

What this is: a cwd-scoped filter that sits between Claude Code's
`typescript-lsp`/`rust-analyzer-lsp` plugins and the real language server,
dropping `textDocument/publishDiagnostics` for files outside the session's
own working tree. Full detail: `README.md`.

- NEVER hand-edit anything under `~/.claude/plugins/cache/**` — that tree is
  no longer the attach point (see README "Attach mechanism"). The real
  attach point is `$HOME/.claude/bin`, first on `PATH` in every sampled
  session; this repo's installer shadows the real command names there. On a
  deploy-managed box (e.g. Overdeck) that directory is itself owned by the
  deploy convergence, so the durable shim lives in that repo's source, not
  written here at install time — see README "Durability".
- Test: `/usr/bin/node tests/filter.test.mjs && bash tests/installer.test.sh &&
  /usr/bin/node tests/integration.test.mjs` — use the real node binary by
  absolute path; a PATH shim on this box redirects `node` to a remote build
  runner that requires a `package.json`/lockfile this repo doesn't have.
  `integration.test.mjs` drives the real installed `typescript-language-server`
  (skips itself, loudly, if that binary isn't present); it also probes for a
  functional `rust-analyzer` binary and reports a named gap if only the
  non-functional `rustup` proxy stub exists.
- Install: `./install-quietlsp` (local/manual install, or `--status` to
  audit what's on disk). Not the durable mechanism on a deploy-managed box —
  see README "Durability".
- Local commits are the landing mechanism for this repo (no CI/PR gate here
  yet). Terse imperative commit messages, no co-author trailer.
