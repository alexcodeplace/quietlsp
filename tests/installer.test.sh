#!/usr/bin/env bash
# Installer idempotency and --status verdict tests. Runs entirely inside a
# throwaway sandbox (fake plugin cache root, fake PATH, fake real binary) —
# never touches ~/.claude/plugins or /usr/local/bin.
set -uo pipefail
REPO="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf -- "$SANDBOX"' EXIT

fail=0
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; fail=1; }

# --- fixture: a fake plugin cache with two version dirs (mirrors the real
# typescript-lsp/1.0.0 shape + a hypothetical 1.0.1 update) and a fake real
# binary reachable only via a non-shim PATH entry.
CACHE="$SANDBOX/cache"
mkdir -p "$CACHE/typescript-lsp/1.0.0" "$CACHE/typescript-lsp/1.0.1" "$CACHE/rust-analyzer-lsp/1.0.0"
REALDIR="$SANDBOX/realbin"
mkdir -p "$REALDIR"
cat >"$REALDIR/typescript-language-server" <<'EOF'
#!/usr/bin/env bash
# Mimics a real LSP server enough for the launch probe: --version exits
# immediately (as typescript-language-server/rust-analyzer do); anything
# else behaves as a stdio pipe-through for the filter-level fixtures.
if [ "${1:-}" = "--version" ]; then echo "fake-1.0.0"; exit 0; fi
exec cat
EOF
chmod 755 "$REALDIR/typescript-language-server"
# rust-analyzer deliberately absent from PATH: exercises the "skip, no real
# binary found" branch without a fatal exit.

export QUIETLSP_PLUGIN_CACHE="$CACHE"
export QUIETLSP_STATE_DIR="$SANDBOX/state"
export PATH="$REALDIR:/usr/bin:/bin"
INSTALLER="$REPO/install-quietlsp"

run() { "$INSTALLER" "$@"; }

# 1. First install: both version dirs of typescript-lsp get wrapped.
out="$(run 2>&1)"; rc=$?
[ $rc -eq 0 ] && [ -x "$CACHE/typescript-lsp/1.0.0/bin/typescript-language-server" ] \
  && [ -x "$CACHE/typescript-lsp/1.0.1/bin/typescript-language-server" ] \
  && ok "install wraps every version dir" \
  || { not_ok "install wraps every version dir"; echo "$out"; }

# 2. --status is clean after install (rust-analyzer skipped, not unwrapped —
#    no real binary exists in this sandbox to wrap it against).
out="$(run --status 2>&1)"; rc=$?
[ $rc -eq 0 ] && ok "--status clean after install" || { not_ok "--status clean after install"; echo "$out"; }

# 3. Re-running install is a no-op (idempotent): same file bytes, no new
#    wrapped/refreshed count.
before0="$(cat "$CACHE/typescript-lsp/1.0.0/bin/typescript-language-server")"
before1="$(cat "$CACHE/typescript-lsp/1.0.1/bin/typescript-language-server")"
out="$(run 2>&1)"
after0="$(cat "$CACHE/typescript-lsp/1.0.0/bin/typescript-language-server")"
after1="$(cat "$CACHE/typescript-lsp/1.0.1/bin/typescript-language-server")"
[ "$before0" = "$after0" ] && [ "$before1" = "$after1" ] && echo "$out" | grep -q 'wrapped=0 refreshed=0' \
  && ok "second install run is idempotent (no-op)" \
  || { not_ok "second install run is idempotent (no-op)"; echo "$out"; }

# 4. Drift detection: hand-corrupt one shim (keep the marker so it still
#    reads as ours, change the body so it no longer matches), --status must
#    flag it and exit non-zero.
{
  echo '#!/usr/bin/env bash'
  echo "# quietlsp-guard v1 — DO NOT EDIT. Reinstall with install-quietlsp."
  echo 'exec echo drifted-body'
} > "$CACHE/typescript-lsp/1.0.0/bin/typescript-language-server"
out="$(run --status 2>&1)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q 'DRIFTED' \
  && ok "--status reports drift and exits non-zero" \
  || { not_ok "--status reports drift and exits non-zero"; echo "$out"; }

# 5. Re-running install repairs drift.
run >/dev/null 2>&1
out="$(run --status 2>&1)"; rc=$?
[ $rc -eq 0 ] && ok "install repairs drifted shim" || { not_ok "install repairs drifted shim"; echo "$out"; }

# 6. --uninstall removes shims and their now-empty bin/ dirs.
run --uninstall >/dev/null 2>&1
[ ! -e "$CACHE/typescript-lsp/1.0.0/bin/typescript-language-server" ] \
  && [ ! -e "$CACHE/typescript-lsp/1.0.1/bin/typescript-language-server" ] \
  && ok "--uninstall removes shims" || not_ok "--uninstall removes shims"

# 7. --status after uninstall reports UNWRAPPED, exits non-zero.
out="$(run --status 2>&1)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q 'UNWRAPPED' \
  && ok "--status reports UNWRAPPED after uninstall" \
  || { not_ok "--status reports UNWRAPPED after uninstall"; echo "$out"; }

# 8. Pre-validate ALL targets before any write (R8): a collision in a LATER
#    version dir must refuse the WHOLE run, leaving an EARLIER, otherwise-
#    installable version dir untouched (no bin/ created at all).
mkdir -p "$CACHE/typescript-lsp/1.0.2/bin"
echo 'not a shim' > "$CACHE/typescript-lsp/1.0.2/bin/typescript-language-server"
out="$(run 2>&1)"; rc=$?
[ $rc -ne 0 ] && [ ! -e "$CACHE/typescript-lsp/1.0.0/bin" ] \
  && ok "install validates every target before writing any (collision refuses whole run)" \
  || { not_ok "install validates every target before writing any (collision refuses whole run)"; echo "$out"; }
rm -rf -- "$CACHE/typescript-lsp/1.0.2"

# 9. Nested wrapper refusal: a "real" binary that is itself a quietlsp shim
#    (found via PATH, outside our own cache dirs) must refuse loudly, not
#    wrap a wrapper.
NESTED_DIR="$SANDBOX/nested-real"
mkdir -p "$NESTED_DIR"
{
  echo '#!/usr/bin/env bash'
  echo '# quietlsp-guard v1 — DO NOT EDIT. Reinstall with install-quietlsp.'
  echo 'exec cat'
} > "$NESTED_DIR/typescript-language-server"
chmod 755 "$NESTED_DIR/typescript-language-server"
out="$(PATH="$NESTED_DIR:/usr/bin:/bin" run 2>&1)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q 'nested wrapper' \
  && ok "install refuses to wrap a real binary that is itself a quietlsp shim" \
  || { not_ok "install refuses to wrap a real binary that is itself a quietlsp shim"; echo "$out"; }
rm -rf -- "$NESTED_DIR"

# 10. --uninstall removes only recorded installs and leaves no stale records.
run >/dev/null 2>&1
record_count_before="$(find "$QUIETLSP_STATE_DIR/installs" -name '*.json' 2>/dev/null | wc -l)"
run --uninstall >/dev/null 2>&1
record_count_after="$(find "$QUIETLSP_STATE_DIR/installs" -name '*.json' 2>/dev/null | wc -l)"
[ "$record_count_before" -gt 0 ] && [ "$record_count_after" -eq 0 ] \
  && ok "--uninstall clears every recorded install, proving scoped restore" \
  || { not_ok "--uninstall clears every recorded install, proving scoped restore"; echo "before=$record_count_before after=$record_count_after"; }

if [ "$fail" -eq 0 ]; then
  echo "install-quietlsp tests: all passed"
else
  echo "install-quietlsp tests: FAILED"
  exit 1
fi
