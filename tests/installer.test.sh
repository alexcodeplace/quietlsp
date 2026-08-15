#!/usr/bin/env bash
# Installer idempotency and --status verdict tests. Runs entirely inside a
# throwaway sandbox (fake shim dir, fake PATH, fake real binary) — never
# touches ~/.claude/bin or /usr/local/bin.
set -uo pipefail
REPO="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf -- "$SANDBOX"' EXIT

fail=0
ok() { echo "ok - $1"; }
not_ok() { echo "not ok - $1"; fail=1; }

SHIM_DIR="$SANDBOX/shimbin"
REALDIR="$SANDBOX/realbin"
mkdir -p "$REALDIR"
cat >"$REALDIR/typescript-language-server" <<'EOF'
#!/usr/bin/env bash
exec cat
EOF
chmod 755 "$REALDIR/typescript-language-server"
# rust-analyzer deliberately absent from PATH: exercises the "skip, no real
# binary found" branch without a fatal exit.

export QUIETLSP_SHIM_DIR="$SHIM_DIR"
export PATH="$REALDIR:/usr/bin:/bin"
INSTALLER="$REPO/install-quietlsp"
run() { "$INSTALLER" "$@"; }

# 1. First install wraps the real target, creating the shim dir.
out="$(run 2>&1)"; rc=$?
[ $rc -eq 0 ] && [ -x "$SHIM_DIR/typescript-language-server" ] \
  && ok "install wraps the target" \
  || { not_ok "install wraps the target"; echo "$out"; }

# 2. --status is clean after install.
out="$(run --status 2>&1)"; rc=$?
[ $rc -eq 0 ] && ok "--status clean after install" || { not_ok "--status clean after install"; echo "$out"; }

# 3. Re-running install is a no-op (idempotent).
before="$(cat "$SHIM_DIR/typescript-language-server")"
out="$(run 2>&1)"
after="$(cat "$SHIM_DIR/typescript-language-server")"
[ "$before" = "$after" ] && echo "$out" | grep -q 'wrapped=0 refreshed=0' \
  && ok "second install run is idempotent (no-op)" \
  || { not_ok "second install run is idempotent (no-op)"; echo "$out"; }

# 4. Drift detection: hand-corrupt the shim (keep the marker so it still
#    reads as ours, change the body so it no longer matches).
{
  echo '#!/usr/bin/env bash'
  echo "# quietlsp-guard v2 — DO NOT EDIT. Reinstall with install-quietlsp."
  echo 'exec echo drifted-body'
} > "$SHIM_DIR/typescript-language-server"
out="$(run --status 2>&1)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q 'DRIFTED' \
  && ok "--status reports drift and exits non-zero" \
  || { not_ok "--status reports drift and exits non-zero"; echo "$out"; }

# 5. Re-running install repairs drift.
run >/dev/null 2>&1
out="$(run --status 2>&1)"; rc=$?
[ $rc -eq 0 ] && ok "install repairs drifted shim" || { not_ok "install repairs drifted shim"; echo "$out"; }

# 6. --uninstall removes the shim.
run --uninstall >/dev/null 2>&1
[ ! -e "$SHIM_DIR/typescript-language-server" ] \
  && ok "--uninstall removes shim" || not_ok "--uninstall removes shim"

# 7. --status after uninstall reports UNWRAPPED, exits non-zero.
out="$(run --status 2>&1)"; rc=$?
[ $rc -ne 0 ] && echo "$out" | grep -q 'UNWRAPPED' \
  && ok "--status reports UNWRAPPED after uninstall" \
  || { not_ok "--status reports UNWRAPPED after uninstall"; echo "$out"; }

# 8. resolve_real never resolves through the shim dir itself (no self-loop
#    when the shim dir is already on PATH ahead of the real binary).
export PATH="$SHIM_DIR:$REALDIR:/usr/bin:/bin"
run >/dev/null 2>&1
target_line="$(head -3 "$SHIM_DIR/typescript-language-server" | tail -1)"
echo "$target_line" | grep -qF "$REALDIR/typescript-language-server" \
  && ok "install resolves the real binary, not its own shim, even when shim dir leads PATH" \
  || { not_ok "install resolves the real binary, not its own shim, even when shim dir leads PATH"; cat "$SHIM_DIR/typescript-language-server"; }

if [ "$fail" -eq 0 ]; then
  echo "install-quietlsp tests: all passed"
else
  echo "install-quietlsp tests: FAILED"
  exit 1
fi
