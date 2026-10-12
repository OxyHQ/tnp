#!/usr/bin/env bash
# Sign a client release's SHA256SUMS with the release key.
#
#   TNP_RELEASE_SIGNING_SEED=<base64 of the 32-byte Ed25519 seed> \
#     bash .github/scripts/sign-release.sh <release-dir>
#
# Writes <release-dir>/SHA256SUMS.sig: the raw 64-byte Ed25519 signature over
# the exact bytes of SHA256SUMS (the format `openssl pkeyutl -verify -rawin`,
# the installers and `tnp update` read).
#
# Uses only bash, coreutils and OpenSSL 3 — no Bun, no node_modules — so the
# seed is never present in a process that loaded third-party package code. The
# release workflow runs it in a job that installs no dependencies.
#
# Refuses unless the seed derives the public key pinned in
# packages/shared-types/src/release.ts, then verifies the new signature with
# that pinned key and re-checks every checksum. A wrong or rotated secret fails
# the release instead of shipping a signature no client accepts.
#
# TNP_RELEASE_KEY_SOURCE overrides the file the pinned key is read from; it
# exists for the test suite only.
set -euo pipefail

die() { echo "::error::sign-release: $*" >&2; exit 1; }

dir="${1:-}"
[ -n "$dir" ] && [ -f "$dir/SHA256SUMS" ] || die "usage: sign-release.sh <dir containing SHA256SUMS>"
[ ! -e "$dir/SHA256SUMS.sig" ] || die "$dir/SHA256SUMS.sig already exists"
[ -n "${TNP_RELEASE_SIGNING_SEED:-}" ] || die "TNP_RELEASE_SIGNING_SEED is not set"
openssl version | grep -Eq '^OpenSSL ([3-9]|[1-9][0-9]+)\.' || die "OpenSSL 3 or later is required"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
key_source="${TNP_RELEASE_KEY_SOURCE:-$repo_root/packages/shared-types/src/release.ts}"
pinned_b64="$(sed -nE "s/^export const RELEASE_SIGNING_PUBLIC_KEY_BASE64 = '([A-Za-z0-9+/]{43}=)';$/\1/p" "$key_source")"
[ "$(printf '%s\n' "$pinned_b64" | grep -c .)" = "1" ] || die "could not read the pinned key from $key_source"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"
umask 077

# Ed25519 SubjectPublicKeyInfo (RFC 8410) for the pinned key.
{
  echo '-----BEGIN PUBLIC KEY-----'
  { printf '\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00'; printf '%s' "$pinned_b64" | base64 -d; } | base64 -w0
  echo
  echo '-----END PUBLIC KEY-----'
} > "$work/pinned.pem"

# Ed25519 PKCS#8 private key (RFC 8410) wrapping the 32-byte seed.
seed_len="$(printf '%s' "$TNP_RELEASE_SIGNING_SEED" | base64 -d 2>/dev/null | wc -c)" || seed_len=0
[ "$seed_len" = "32" ] || die "TNP_RELEASE_SIGNING_SEED must be the base64 of exactly 32 bytes"
{ printf '\x30\x2e\x02\x01\x00\x30\x05\x06\x03\x2b\x65\x70\x04\x22\x04\x20'; printf '%s' "$TNP_RELEASE_SIGNING_SEED" | base64 -d; } > "$work/seed.der"

openssl pkey -inform DER -in "$work/seed.der" -pubout -out "$work/derived.pem"
cmp -s "$work/derived.pem" "$work/pinned.pem" || die "the signing seed does not derive the pinned release public key; refusing to sign"

openssl pkeyutl -sign -inkey "$work/seed.der" -keyform DER -rawin \
  -in "$dir/SHA256SUMS" -out "$work/SHA256SUMS.sig"
rm -f "$work/seed.der"

[ "$(wc -c < "$work/SHA256SUMS.sig")" = "64" ] || die "signature is not 64 bytes"
openssl pkeyutl -verify -pubin -inkey "$work/pinned.pem" -rawin \
  -in "$dir/SHA256SUMS" -sigfile "$work/SHA256SUMS.sig" >/dev/null \
  || die "the new signature does not verify with the pinned key"
(cd "$dir" && sha256sum --check --strict --quiet SHA256SUMS) || die "SHA256SUMS does not match the files"

cp "$work/SHA256SUMS.sig" "$dir/SHA256SUMS.sig"
chmod 644 "$dir/SHA256SUMS.sig"
echo "Signed SHA256SUMS -> SHA256SUMS.sig; verified with the pinned key $pinned_b64"
