#!/bin/sh
# TNP Resolver Installer
# Usage: curl -fsSL https://get.tnp.network | sh
set -e

REPO="OxyHQ/tnp"
VERSION="0.1.0"
INSTALL_DIR="/usr/local/bin"
TNP_BIN="$INSTALL_DIR/tnp"

echo ""
echo "  TNP -- The Network Protocol"
echo "  Resolver v$VERSION"
echo ""

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  darwin) PLATFORM="darwin-$ARCH" ;;
  linux)  PLATFORM="linux-$ARCH" ;;
  *)
    echo "Error: unsupported OS: $OS"
    echo "For Windows, run this in PowerShell as Administrator:"
    echo "  irm https://get.tnp.network | iex"
    exit 1
    ;;
esac

DOWNLOAD_URL="https://github.com/$REPO/releases/download/v$VERSION/tnp-$PLATFORM"

echo "  Platform: $PLATFORM"
echo "  Downloading from: $DOWNLOAD_URL"
echo ""

# Check for sudo/root
SUDO=""
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    echo "  Root access required. You may be prompted for your password."
    echo ""
  else
    echo "Error: this installer needs root access. Run with sudo."
    exit 1
  fi
fi

# Download binary
TMPFILE=$(mktemp)
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$TMPFILE"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$DOWNLOAD_URL" -O "$TMPFILE"
else
  echo "Error: curl or wget required"
  exit 1
fi

# Install binary
$SUDO mv "$TMPFILE" "$TNP_BIN"
$SUDO chmod 755 "$TNP_BIN"
echo "  Installed: $TNP_BIN"

# Install as system service
$SUDO "$TNP_BIN" install
echo ""
echo "  Done! TNP domains now resolve on this device."
echo ""
echo "  Try it:  dig example.ox @127.0.0.1 -p 5354"
echo "  Status:  tnp status"
echo "  Remove:  sudo tnp uninstall"
echo ""
echo "  Register a domain: https://tnp.network/register"
echo ""
