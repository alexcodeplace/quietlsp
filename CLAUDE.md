# Agent instructions — QuietLSP

QuietLSP filters Claude Code LSP `publishDiagnostics` messages to the current working directory/workspace roots. Read `README.md` and `docs/SPEC.md` before changing framing, path containment, capability rewriting, or installer behavior.

- Never edit Claude Code plugin-cache files. The supported install seam is a PATH-shadowing shim; `QUIETLSP_SHIM_DIR` controls its location.
- Preserve fail-open behavior for framing/classification uncertainty. Filtering noise is less important than keeping the LSP stream usable.
- Preserve byte-identical passthrough for frames that are not intentionally rewritten.
- Test with: `node tests/filter.test.mjs && bash tests/installer.test.sh && node tests/integration.test.mjs`.
- `integration.test.mjs` may skip when the real TypeScript language server is unavailable; do not represent a skip or the named Rust gap as full integration coverage.
- Use terse commits and do not include machine-specific paths, hostnames, deployment topology, credentials, or personal environment assumptions in public files.
