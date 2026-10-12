#!/usr/bin/env bash
# Run the real, rendered install.sh against the real signed GitHub release on
# macOS, as an ordinary user. Run by .github/workflows/client-platforms.yml.
#
#  1. With the system's /usr/bin/openssl (LibreSSL, which cannot check
#     Ed25519): it says clearly that only the checksum was checked, and
#     installs; with TNP_REQUIRE_SIGNATURE=1 it refuses and installs nothing;
#     with the binary altered in transit the checksum refuses it.
#  2. With Homebrew's OpenSSL 3 first on PATH: the signature verifies with the
#     pinned key; with SHA256SUMS altered in transit it refuses.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="${E2E_LOG_DIR:-$(mktemp -d)}"
mkdir -p "$LOG"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failed=0
fail() { echo "FAIL $*"; failed=1; }
pass() { echo "PASS $*"; }

bun "$HERE/render-installer.ts" install.sh "$WORK/install.sh"
VERSION="$(sed -n 's/^DEFAULT_VERSION="\([0-9.]*\)"$/\1/p' "$WORK/install.sh")"
[ -n "$VERSION" ] || { echo "no version in the rendered install.sh"; exit 1; }

# A curl that runs the real one, then appends a byte to the file named by
# $TAMPER when that is what was downloaded: a change in transit.
mkdir -p "$WORK/tamper-bin"
cat > "$WORK/tamper-bin/curl" <<'EOF'
#!/bin/sh
out=""; prev=""; url=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  prev="$arg"; url="$arg"
done
/usr/bin/curl "$@" || exit $?
case "$url" in
  */"$TAMPER") printf '\n' >> "$out"; echo "(test) appended a byte to $TAMPER after download" >&2 ;;
esac
EOF
chmod 755 "$WORK/tamper-bin/curl"

SYSTEM_PATH=/usr/bin:/bin:/usr/sbin:/sbin

# run <name> <PATH> [VAR=value...]: run install.sh non-interactively into its
# own directory; leaves output in $LOG/install-sh-<name>.log and the exit code
# in $code.
run() {
  local name="$1" path="$2"; shift 2
  local dir="$WORK/$name"
  mkdir -p "$dir/bin" "$dir/tmp"
  code=0
  env -i PATH="$path" HOME="$dir" TMPDIR="$dir/tmp" NO_COLOR=1 TNP_INSTALL_DIR="$dir/bin" "$@" \
    sh "$WORK/install.sh" < /dev/null > "$LOG/install-sh-$name.log" 2>&1 || code=$?
  cat "$LOG/install-sh-$name.log"
  installed="$dir/bin/tnp"
}

has() { grep -qF -- "$2" "$LOG/install-sh-$1.log"; }

echo "== system openssl: $(/usr/bin/openssl version)"
/usr/bin/openssl version | grep -q '^LibreSSL' || fail "/usr/bin/openssl is not LibreSSL on this runner"

run libressl "$SYSTEM_PATH"
if [ "$code" != 0 ]; then fail "install.sh with LibreSSL exited $code"
elif ! has libressl 'Could not check the release SIGNATURE: no OpenSSL 3 found'; then fail "no clear warning that the signature was not checked"
elif ! has libressl 'Only the SHA-256 checksum will be checked'; then fail "no statement that only the checksum is checked"
elif ! has libressl 'Signature not checked on this machine; checksum only'; then fail "the closing summary does not repeat that the signature was not checked"
elif ! has libressl "SHA-256 of tnp-darwin-"; then fail "the checksum was not reported as checked"
elif [ "$("$installed" version)" != "tnp v$VERSION" ]; then fail "the installed binary does not report tnp v$VERSION"
else pass "LibreSSL: checksum-only, said so twice, and installed a working tnp v$VERSION"
fi

run libressl-required "$SYSTEM_PATH" TNP_REQUIRE_SIGNATURE=1
if [ "$code" = 0 ]; then fail "install.sh with TNP_REQUIRE_SIGNATURE=1 and LibreSSL succeeded"
elif ! has libressl-required 'TNP_REQUIRE_SIGNATURE=1 but this machine has no OpenSSL 3'; then fail "the refusal does not say why"
elif [ -e "$installed" ]; then fail "TNP_REQUIRE_SIGNATURE=1 refused but a binary was installed"
else pass "LibreSSL with TNP_REQUIRE_SIGNATURE=1: refused, nothing installed"
fi

asset="tnp-darwin-$(uname -m | sed 's/x86_64/x64/')"
run libressl-tampered-binary "$WORK/tamper-bin:$SYSTEM_PATH" TAMPER="$asset"
if [ "$code" = 0 ]; then fail "install.sh accepted a binary altered in transit"
elif ! has libressl-tampered-binary 'Checksum mismatch'; then fail "an altered binary was not refused for its checksum"
elif [ -e "$installed" ]; then fail "an altered binary was installed"
else pass "LibreSSL: a binary altered in transit is refused by the checksum, nothing installed"
fi

openssl3=""
if command -v brew >/dev/null 2>&1; then
  prefix="$(brew --prefix openssl@3 2>/dev/null || true)"
  [ -n "$prefix" ] && [ -x "$prefix/bin/openssl" ] && openssl3="$prefix/bin"
fi
if [ -z "$openssl3" ]; then
  echo "::warning::Homebrew openssl@3 is not on this runner; the OpenSSL 3 signature path was not run"
else
  echo "== OpenSSL 3: $("$openssl3/openssl" version)"
  run openssl3 "$openssl3:$SYSTEM_PATH"
  if [ "$code" != 0 ]; then fail "install.sh with OpenSSL 3 exited $code"
  elif ! has openssl3 'Signature on SHA256SUMS verified with the pinned TNP release key.'; then fail "the signature was not verified with OpenSSL 3"
  elif has openssl3 'Signature not checked'; then fail "OpenSSL 3 run still says the signature was not checked"
  elif [ "$("$installed" version)" != "tnp v$VERSION" ]; then fail "the installed binary does not report tnp v$VERSION"
  else pass "OpenSSL 3: the real v$VERSION signature verifies and a working binary is installed"
  fi

  run openssl3-tampered-sums "$WORK/tamper-bin:$openssl3:$SYSTEM_PATH" TAMPER=SHA256SUMS
  if [ "$code" = 0 ]; then fail "install.sh accepted a SHA256SUMS altered in transit"
  elif ! has openssl3-tampered-sums 'NOT a valid signature by the TNP release key'; then fail "an altered SHA256SUMS was not refused for its signature"
  elif [ -e "$installed" ]; then fail "an altered SHA256SUMS still installed a binary"
  else pass "OpenSSL 3: a SHA256SUMS altered in transit is refused, nothing installed"
  fi
fi

[ "$failed" = 0 ] || exit 1
echo "install.sh on macOS: ALL PASS"
