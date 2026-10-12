# Checks for the exit's on-disk secrets (TNP_EXIT_SECRETS=file), sourced by
# wg-up.sh and bootstrap.sh. POSIX sh; defines functions only.
#
# Where there is no instance role to read SSM with (Lightsail), the operator
# copies the WireGuard private key and the agent token to
#   /etc/tnp-exit/secrets/wg-private-key
#   /etc/tnp-exit/secrets/agent-token
# over SSH (docs/architecture/exit-nodes.md §9.8). They are refused, and wg0
# never comes up, unless the directory is a real directory (not a symlink)
# owned by root with mode 0700 (or 0500), and each file is a regular file (not
# a symlink, not hard-linked elsewhere) owned by root with mode 0600 (or 0400).
# Anything looser means someone other than root could have read or replaced
# the key.

TNP_EXIT_SECRETS_DIR=/etc/tnp-exit/secrets

# check_secret_dir DIR OWNER_UID
check_secret_dir() {
  if [ -L "$1" ] || [ ! -d "$1" ]; then
    echo "tnp-exit: $1 must be a directory, not a symlink" >&2
    return 1
  fi
  _meta=$(stat -c '%u %a' "$1") || return 1
  case "$_meta" in
    "$2 700" | "$2 500") return 0 ;;
  esac
  echo "tnp-exit: $1 must be owned by uid $2 with mode 0700 (it is: uid/mode $_meta)" >&2
  return 1
}

# check_secret_file FILE OWNER_UID
check_secret_file() {
  if [ -L "$1" ] || [ ! -f "$1" ]; then
    echo "tnp-exit: $1 must be a regular file, not a symlink" >&2
    return 1
  fi
  _meta=$(stat -c '%u %a %h' "$1") || return 1
  case "$_meta" in
    "$2 600 1" | "$2 400 1") return 0 ;;
  esac
  echo "tnp-exit: $1 must be owned by uid $2 with mode 0600 and no other links (it is: uid/mode/links $_meta)" >&2
  return 1
}

# check_file_secrets DIR OWNER_UID — the directory and both secrets.
check_file_secrets() {
  check_secret_dir "$1" "$2" &&
    check_secret_file "$1/wg-private-key" "$2" &&
    check_secret_file "$1/agent-token" "$2"
}
