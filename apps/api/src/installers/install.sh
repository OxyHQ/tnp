#!/bin/sh
# TNP Installer -- https://tnp.network
# Usage: curl -fsSL https://get.tnp.network | sh
#
# Downloads the TNP client v__TNP_VERSION__ for this OS/arch from the fixed
# GitHub release URL, verifies it, installs it, and optionally installs the
# local TNP service.
#
# Verification, before anything downloaded is run or moved:
#   1. SHA256SUMS.sig must be a valid Ed25519 signature over SHA256SUMS by the
#      release key embedded below (needs OpenSSL 3; see "Signature" below).
#   2. The binary's SHA-256 must equal its line in SHA256SUMS.
# Any mismatch stops the install. There is no fallback URL.
#
# Trust: this script itself comes from get.tnp.network over HTTPS, so whoever
# controls that host controls this script and the key in it. To check a
# release independently of it, see https://github.com/OxyHQ/tnp/blob/main/docs/architecture/security.md
#
# Environment:
#   TNP_VERSION=x.y.z          install that release instead of v__TNP_VERSION__
#   TNP_INSTALL_DIR=/path      install there instead of /usr/local/bin
#   TNP_REQUIRE_SIGNATURE=1    fail instead of continuing when the signature
#                              cannot be checked on this machine
#   NO_COLOR=1                 plain output

set -eu

# ── ANSI colors ──────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  CYAN=''
  BOLD=''
  DIM=''
  RESET=''
fi

# ── Logging helpers ──────────────────────────────────────────────────────────

info()    { printf "${BLUE}>>>${RESET} %s\n" "$*"; }
success() { printf "${GREEN}>>>${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}>>>${RESET} %s\n" "$*"; }
error()   { printf "${RED}>>>${RESET} %s\n" "$*" >&2; }
fatal()   { error "$*"; exit 1; }

# ── Constants ────────────────────────────────────────────────────────────────

REPO="__TNP_REPO__"
DEFAULT_VERSION="__TNP_VERSION__"
INSTALL_DIR="${TNP_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="tnp"
WORKDIR=""

# The release signing public key (Ed25519, SubjectPublicKeyInfo). The same key
# is pinned in the client for `tnp update`.
RELEASE_KEY_PEM='__TNP_RELEASE_KEY_PEM__'

# ── Welcome banner ───────────────────────────────────────────────────────────

banner() {
  printf "\n"
  printf "${CYAN}${BOLD}"
  printf "  _____ _   _ ____  \n"
  printf " |_   _| \\ | |  _ \\ \n"
  printf "   | | |  \\| | |_) |\n"
  printf "   | | | |\\  |  __/ \n"
  printf "   |_| |_| \\_|_|    \n"
  printf "${RESET}\n"
  printf "  ${DIM}The Network Protocol${RESET}\n"
  printf "  ${DIM}https://tnp.network${RESET}\n"
  printf "\n"
}

# ── Platform detection ───────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin)  PLATFORM_OS="darwin"  ;;
    Linux)   PLATFORM_OS="linux"   ;;
    *)       fatal "Unsupported operating system: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)   PLATFORM_ARCH="x64"   ;;
    arm64|aarch64)  PLATFORM_ARCH="arm64" ;;
    *)              fatal "Unsupported architecture: $ARCH" ;;
  esac

  PLATFORM="${PLATFORM_OS}-${PLATFORM_ARCH}"
  ASSET="tnp-${PLATFORM}"
  info "Detected platform: ${BOLD}${PLATFORM}${RESET}"
}

# ── HTTP client abstraction ──────────────────────────────────────────────────

detect_http_client() {
  if command -v curl >/dev/null 2>&1; then
    HTTP_CLIENT="curl"
  elif command -v wget >/dev/null 2>&1; then
    HTTP_CLIENT="wget"
  else
    fatal "Neither curl nor wget found. Please install one and try again."
  fi
}

# Download a URL to a file over HTTPS only.
http_download() {
  url="$1"
  dest="$2"
  case "$HTTP_CLIENT" in
    curl)
      if [ -t 1 ]; then
        curl --proto '=https' --tlsv1.2 -fSL --progress-bar -o "$dest" "$url"
      else
        curl --proto '=https' --tlsv1.2 -fsSL -o "$dest" "$url"
      fi
      ;;
    wget)
      wget --https-only -q -O "$dest" "$url"
      ;;
  esac
}

# ── Resolve the version ──────────────────────────────────────────────────────

# A version is interpolated into a URL, so only a strict x.y.z is accepted.
is_strict_semver() {
  # Digits and dots only (this also rejects a newline, which grep would split
  # on), then the exact shape.
  case "$1" in
    ''|*[!0-9.]*) return 1 ;;
  esac
  printf '%s' "$1" | grep -Eq '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
}

resolve_version() {
  VERSION="${TNP_VERSION:-$DEFAULT_VERSION}"
  if ! is_strict_semver "$VERSION"; then
    fatal "Refusing version '$VERSION': expected x.y.z"
  fi
  BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"
  info "Version: ${BOLD}${VERSION}${RESET}"
}

# ── Download ─────────────────────────────────────────────────────────────────

make_workdir() {
  # A fresh private directory: mktemp picks an unpredictable name and creates
  # it 0700, so no other local user can plant or swap a file in it.
  WORKDIR="$(mktemp -d 2>/dev/null || mktemp -d -t tnp)" || fatal "Could not create a temporary directory."
  [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ] || fatal "Could not create a temporary directory."
  chmod 700 "$WORKDIR"
}

download_release() {
  info "Downloading TNP client v${VERSION} from ${DIM}${BASE_URL}${RESET}"
  http_download "${BASE_URL}/${ASSET}" "${WORKDIR}/${ASSET}" || \
    fatal "Download of ${ASSET} failed. Check your connection and try again."
  http_download "${BASE_URL}/SHA256SUMS" "${WORKDIR}/SHA256SUMS" || \
    fatal "Download of SHA256SUMS failed. Release v${VERSION} may not be signed; not installing."
  http_download "${BASE_URL}/SHA256SUMS.sig" "${WORKDIR}/SHA256SUMS.sig" || \
    fatal "Download of SHA256SUMS.sig failed. Release v${VERSION} may not be signed; not installing."
}

# ── Verify ───────────────────────────────────────────────────────────────────

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else
    return 1
  fi
}

# Ed25519 with -rawin needs OpenSSL 3 or later. LibreSSL (macOS /usr/bin/openssl)
# and OpenSSL 1.x cannot check it.
openssl_can_verify_ed25519() {
  command -v openssl >/dev/null 2>&1 || return 1
  openssl version 2>/dev/null | grep -Eq '^OpenSSL ([3-9]|[1-9][0-9]+)\.'
}

verify_signature() {
  SIGNATURE_VERIFIED=0
  if openssl_can_verify_ed25519; then
    printf '%s\n' "$RELEASE_KEY_PEM" > "${WORKDIR}/release-key.pem"
    if openssl pkeyutl -verify -pubin -inkey "${WORKDIR}/release-key.pem" -rawin \
        -in "${WORKDIR}/SHA256SUMS" -sigfile "${WORKDIR}/SHA256SUMS.sig" >/dev/null 2>&1; then
      SIGNATURE_VERIFIED=1
      success "Signature on SHA256SUMS verified with the pinned TNP release key."
    else
      fatal "SHA256SUMS.sig is NOT a valid signature by the TNP release key. Not installing."
    fi
  else
    if [ "${TNP_REQUIRE_SIGNATURE:-}" = "1" ]; then
      fatal "TNP_REQUIRE_SIGNATURE=1 but this machine has no OpenSSL 3 to check the Ed25519 signature."
    fi
    warn "Could not check the release SIGNATURE: no OpenSSL 3 found (macOS ships LibreSSL)."
    warn "Only the SHA-256 checksum will be checked, against SHA256SUMS downloaded"
    warn "from the same GitHub release as the binary. That catches corruption, not tampering."
    warn "Install OpenSSL 3 and re-run, or set TNP_REQUIRE_SIGNATURE=1 to refuse in this case."
  fi
}

verify_checksum() {
  # Exactly one well-formed line for this asset, in sha256sum text or binary mode.
  matches="$(awk -v f="$ASSET" '$2 == f || $2 == ("*" f) { print $1 }' "${WORKDIR}/SHA256SUMS")"
  count="$(printf '%s' "$matches" | grep -c . || true)"
  [ "$count" = "1" ] || fatal "SHA256SUMS has ${count} entries for ${ASSET}, expected 1. Not installing."
  printf '%s' "$matches" | grep -Eq '^[0-9a-f]{64}$' || fatal "SHA256SUMS entry for ${ASSET} is malformed. Not installing."

  actual="$(sha256_of "${WORKDIR}/${ASSET}")" || \
    fatal "No sha256sum, shasum or openssl found to check the download. Not installing."

  if [ "$actual" != "$matches" ]; then
    error "Expected SHA-256: $matches"
    error "Actual SHA-256:   $actual"
    fatal "Checksum mismatch for ${ASSET}. Not installing."
  fi
  success "SHA-256 of ${ASSET} matches SHA256SUMS: ${DIM}${actual}${RESET}"
}

# ── Install binary ───────────────────────────────────────────────────────────

install_binary() {
  TARGET="${INSTALL_DIR}/${BINARY_NAME}"
  TMP_BINARY="${WORKDIR}/${ASSET}"
  chmod 755 "$TMP_BINARY"

  info "Installing to ${BOLD}${TARGET}${RESET}..."

  if [ -w "$INSTALL_DIR" ]; then
    mv -f "$TMP_BINARY" "$TARGET"
  else
    info "Elevated permissions required to install to ${INSTALL_DIR}"
    if command -v sudo >/dev/null 2>&1; then
      sudo mv -f "$TMP_BINARY" "$TARGET"
      sudo chmod 755 "$TARGET"
    elif command -v doas >/dev/null 2>&1; then
      doas mv -f "$TMP_BINARY" "$TARGET"
      doas chmod 755 "$TARGET"
    else
      fatal "Cannot write to ${INSTALL_DIR} and neither sudo nor doas is available."
    fi
  fi

  success "Installed to ${TARGET}"
}

# ── Sudo helper ──────────────────────────────────────────────────────────────

run_elevated() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  elif command -v doas >/dev/null 2>&1; then
    doas "$@"
  else
    error "This operation requires root privileges."
    error "Run the following manually:"
    error "  $*"
    return 1
  fi
}

# ── Interactive setup ────────────────────────────────────────────────────────

dns_setup() {
  printf "\n"
  printf "${BOLD}How would you like to resolve TNP domains?${RESET}\n"
  printf "\n"
  printf "  ${GREEN}1)${RESET} Install TNP service ${DIM}(recommended)${RESET}\n"
  printf "     Runs a local DNS proxy for TNP-native names.\n"
  printf "\n"
  printf "  ${DIM}2)${RESET} Skip -- I'll set it up later\n"
  printf "\n"

  if [ -t 0 ]; then
    printf "${BOLD}Choose [1/2]: ${RESET}"
    read -r CHOICE || CHOICE="2"
  else
    info "Non-interactive mode detected. Skipping service installation."
    CHOICE="2"
  fi

  case "$CHOICE" in
    1)
      info "Installing TNP as a system service..."
      run_elevated "${INSTALL_DIR}/${BINARY_NAME}" install || {
        error "Service installation failed."
        warn "You can retry manually: sudo tnp install"
        return 0
      }
      success "TNP service installed and running."
      ;;
    *)
      printf "\n"
      info "Skipped service installation. Later, use one of:"
      printf "\n"
      printf "  ${GREEN}sudo tnp install${RESET}         Install as a system service\n"
      printf "  ${GREEN}tnp run${RESET}                   Run the resolver manually\n"
      printf "  ${GREEN}tnp connect${RESET}               Overlay client (DNS + SOCKS5 proxy)\n"
      printf "\n"
      ;;
  esac
}

# ── Verify installation ─────────────────────────────────────────────────────

verify_install() {
  printf "\n"
  if ! command -v tnp >/dev/null 2>&1; then
    warn "${INSTALL_DIR} may not be in your PATH."
    warn "Add it with: export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi

  INSTALLED_VERSION="$("${INSTALL_DIR}/${BINARY_NAME}" version 2>/dev/null || echo "")"
  if [ -n "$INSTALLED_VERSION" ]; then
    success "Installed: ${BOLD}${INSTALLED_VERSION}${RESET}"
  else
    warn "Could not run the installed binary."
  fi
}

# ── Success message ──────────────────────────────────────────────────────────

print_success() {
  printf "\n"
  printf "${GREEN}${BOLD}  Installation complete.${RESET}\n"
  if [ "${SIGNATURE_VERIFIED:-0}" != "1" ]; then
    printf "  ${YELLOW}Signature not checked on this machine; checksum only (see above).${RESET}\n"
  fi
  printf "\n"
  printf "  ${BOLD}Get started:${RESET}\n"
  printf "    Register domains  ${DIM}https://tnp.network${RESET}\n"
  printf "    Check status      ${GREEN}tnp status${RESET}\n"
  printf "    Test a domain     ${GREEN}tnp test example.ox${RESET}\n"
  printf "    Update            ${GREEN}sudo tnp update${RESET}\n"
  printf "    All commands      ${GREEN}tnp help${RESET}\n"
  printf "\n"
  printf "  ${DIM}Docs: https://tnp.network/install${RESET}\n"
  printf "\n"
}

# ── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  if [ -n "${WORKDIR:-}" ] && [ -d "$WORKDIR" ]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  banner
  detect_http_client
  detect_platform
  resolve_version
  make_workdir
  download_release
  verify_signature
  verify_checksum
  install_binary
  dns_setup
  verify_install
  print_success
}

main "$@"
