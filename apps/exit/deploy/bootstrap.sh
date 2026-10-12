#!/bin/bash
# Turn a fresh arm64 or x86-64 host into a TNP WireGuard exit.
#
# Supported: Amazon Linux 2023 (EC2), Debian 12, Ubuntu 22.04 / 24.04 (the
# Lightsail OS blueprints, and EC2). Run once, as root — from EC2 user-data, or
# over SSH on Lightsail (docs/architecture/exit-nodes.md §9.5 and §9.8 have the
# procedures and the infrastructure they expect). Idempotent: re-running it
# with a new TNP_EXIT_COMMIT upgrades in place, though replacing the instance
# is the preferred upgrade.
#
# Inputs (environment). None of them is secret:
#   TNP_EXIT_ID             required. Short id matching TNP_VPN_EXITS, e.g. use1-1.
#   TNP_EXIT_COMMIT         required. Full 40-hex commit of OxyHQ/tnp to run.
#   TNP_EXIT_SECRETS        ssm (default; EC2 with an instance role) or file
#                           (Lightsail): where the WireGuard private key and the
#                           agent token come from (wg-up.sh, secrets.sh).
#   TNP_EXIT_SSM_PREFIX     ssm only. Default /tnp/exit/$TNP_EXIT_ID. Holds two
#                           SecureStrings: <prefix>/wg-private-key, <prefix>/agent-token.
#   TNP_API_URL             default https://api.tnp.network
#   TNP_VPN_DNS             the network-wide resolver IPs (same value as the API's);
#                           DNS forwarded to them is rate-limited per peer.
#   TNP_EXIT_DNS_UPSTREAM   the exit resolver's DoH upstreams, comma-separated
#                           https:// URLs. Default https://1.1.1.1/dns-query,https://8.8.8.8/dns-query
#   TNP_EXIT_MONTHLY_CAP_GB monthly traffic cap, in + out on the uplink, decimal GB.
#                           Unset or 0: no cap. TNP_EXIT_THROTTLE_MBIT (default 2)
#                           is the forwarding rate once it is reached.
#   TNP_EXIT_SSH_FROM       CIDR(s) allowed to reach SSH on the host after the
#                           packet filter loads. Default none: no SSH.
#
# What it never does: put a secret in user-data or a log, enable any log of
# traffic, or open anything to the internet but UDP 51820.
set -euo pipefail

BUN_VERSION=1.4.3
# sha256 of bun-linux-<arch>.zip for $BUN_VERSION, from the release's SHASUMS256.txt.
BUN_SHA256_AARCH64=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21
BUN_SHA256_X64=3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18
REPO=https://github.com/OxyHQ/tnp.git
ROOT=/opt/tnp-exit
# The tunnel gateway address (VPN_EXIT_TUNNEL_IPV4): the exit's resolver listens here.
GATEWAY4=10.77.0.1
DEFAULT_DNS_UPSTREAM=https://1.1.1.1/dns-query,https://8.8.8.8/dns-query

die() {
  echo "tnp-exit bootstrap: $*" >&2
  exit 1
}

# --- Functions (deploy.test.ts sources this file to test them) --------------

# The package manager for a supported OS, from an os-release file; non-zero otherwise.
detect_distro() {
  local id version
  id=$(sed -n 's/^ID=//p' "$1" | head -n 1 | tr -d "\"'")
  version=$(sed -n 's/^VERSION_ID=//p' "$1" | head -n 1 | tr -d "\"'")
  case "$id:$version" in
    amzn:2023) echo dnf ;;
    debian:12) echo apt ;;
    ubuntu:22.04 | ubuntu:24.04) echo apt ;;
    *) return 1 ;;
  esac
}

# Where nftables.service loads its ruleset from, per package manager.
nftables_conf() {
  case "$1" in
    dnf) echo /etc/sysconfig/nftables.conf ;;
    apt) echo /etc/nftables.conf ;;
    *) return 1 ;;
  esac
}

# The interface with the IPv4 default route, from `ip -4 route show default` on stdin.
uplink_from_routes() {
  awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }'
}

# Comma list of global addresses with prefix, from `ip -o addr show` on stdin.
addresses_from_ip() {
  awk '$3 == "inet" || $3 == "inet6" { print $4 }' | paste -sd, -
}

# A comma list of https:// DoH URLs (no spaces, quotes or anything a shell or
# unit file would read twice).
valid_doh_list() {
  [[ "$1" =~ ^https://[A-Za-z0-9.:/_-]+(,https://[A-Za-z0-9.:/_-]+)*$ ]]
}

# Sourced (by the tests): stop here, with the functions defined.
if (return 0 2>/dev/null); then return 0; fi

# --- Checks -----------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "must run as root"
case "$(uname -m)" in
  aarch64) BUN_ARCH=aarch64 BUN_SHA256=$BUN_SHA256_AARCH64 ;;
  x86_64) BUN_ARCH=x64 BUN_SHA256=$BUN_SHA256_X64 ;;
  *) die "expects arm64 (aarch64) or x86-64" ;;
esac
PKG=$(detect_distro /etc/os-release) ||
  die "unsupported OS: Amazon Linux 2023, Debian 12 or Ubuntu 22.04/24.04 only"

: "${TNP_EXIT_ID:?TNP_EXIT_ID is required}"
: "${TNP_EXIT_COMMIT:?TNP_EXIT_COMMIT is required}"
TNP_EXIT_SECRETS="${TNP_EXIT_SECRETS:-ssm}"
TNP_API_URL="${TNP_API_URL:-https://api.tnp.network}"
TNP_VPN_DNS="${TNP_VPN_DNS:-}"
TNP_EXIT_SSM_PREFIX="${TNP_EXIT_SSM_PREFIX:-/tnp/exit/$TNP_EXIT_ID}"
TNP_EXIT_DNS_UPSTREAM="${TNP_EXIT_DNS_UPSTREAM:-$DEFAULT_DNS_UPSTREAM}"
TNP_EXIT_MONTHLY_CAP_GB="${TNP_EXIT_MONTHLY_CAP_GB:-0}"
TNP_EXIT_THROTTLE_MBIT="${TNP_EXIT_THROTTLE_MBIT:-2}"
TNP_EXIT_SSH_FROM="${TNP_EXIT_SSH_FROM:-}"

[[ "$TNP_EXIT_ID" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "TNP_EXIT_ID must be lowercase letters, digits, dashes"
[[ "$TNP_EXIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "TNP_EXIT_COMMIT must be a full 40-hex commit"
[[ "$TNP_EXIT_SECRETS" =~ ^(ssm|file)$ ]] || die "TNP_EXIT_SECRETS must be ssm or file"
[[ "$TNP_API_URL" =~ ^https://[a-z0-9.-]+(:[0-9]+)?$ ]] || die "TNP_API_URL must be https://host"
[[ "$TNP_VPN_DNS" =~ ^[0-9a-fA-F.:,]*$ ]] || die "TNP_VPN_DNS must be a comma list of IPs"
[[ "$TNP_EXIT_SSM_PREFIX" =~ ^/[A-Za-z0-9/_.-]+$ ]] || die "TNP_EXIT_SSM_PREFIX is not an SSM path"
valid_doh_list "$TNP_EXIT_DNS_UPSTREAM" || die "TNP_EXIT_DNS_UPSTREAM must be a comma list of https:// DoH URLs"
[[ "$TNP_EXIT_MONTHLY_CAP_GB" =~ ^[0-9]{1,7}$ ]] || die "TNP_EXIT_MONTHLY_CAP_GB must be a whole number of GB"
[[ "$TNP_EXIT_THROTTLE_MBIT" =~ ^[1-9][0-9]{0,4}$ ]] || die "TNP_EXIT_THROTTLE_MBIT must be a whole number of Mbit/s"
[[ "$TNP_EXIT_SSH_FROM" =~ ^[0-9a-fA-F.:/,]*$ ]] || die "TNP_EXIT_SSH_FROM must be a comma list of CIDRs"

# --- Packages ---------------------------------------------------------------
if [ "$PKG" = dnf ]; then
  dnf install -y wireguard-tools nftables conntrack-tools git unzip
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q wireguard-tools nftables conntrack curl git unzip ca-certificates
fi
if [ "$TNP_EXIT_SECRETS" = ssm ] && ! command -v aws >/dev/null; then
  [ "$PKG" = dnf ] || die "TNP_EXIT_SECRETS=ssm needs the AWS CLI v2; install it, or use TNP_EXIT_SECRETS=file"
  dnf install -y awscli-2
fi

# --- Instance facts ---------------------------------------------------------
UPLINK=$(ip -4 route show default | uplink_from_routes)
[ -n "$UPLINK" ] || die "no default route"
# The uplink's own networks: refused to peers like the VPC (on Lightsail, which
# has no VPC metadata to read, they ARE the private network to protect).
UPLINK_ADDRS=$( (
  ip -o -4 addr show dev "$UPLINK" scope global
  ip -o -6 addr show dev "$UPLINK" scope global
) | addresses_from_ip)
[ -n "$UPLINK_ADDRS" ] || die "no address on $UPLINK"

imds_token() {
  curl -fsS -m 3 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null
}
imds() {
  curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $(imds_token)" \
    "http://169.254.169.254/latest/meta-data/$1"
}
IMDS_V1=0
curl -fsS -m 3 -o /dev/null http://169.254.169.254/latest/meta-data/ 2>/dev/null && IMDS_V1=1
HAVE_IMDS=0
imds_token >/dev/null && HAVE_IMDS=1

AWS_REGION=
VPC_CIDRS=
VPC_CIDRS6=
if [ "$TNP_EXIT_SECRETS" = ssm ]; then
  # IMDSv2 must be REQUIRED: with v1 allowed, anything that can make the host
  # issue a plain GET (a confused process, a forwarded request) can read the
  # instance role's credentials, which unlock the exit's private key in SSM.
  [ "$IMDS_V1" -eq 0 ] ||
    die "IMDSv1 answers on this instance; require IMDSv2 (HttpTokens=required, hop limit 1) and relaunch"
  [ "$HAVE_IMDS" -eq 1 ] || die "TNP_EXIT_SECRETS=ssm needs EC2 instance metadata (IMDSv2); use file elsewhere"
  AWS_REGION=$(imds placement/region)
  MAC=$(imds mac)
  VPC_CIDRS=$(imds "network/interfaces/macs/$MAC/vpc-ipv4-cidr-blocks" | paste -sd, -)
  VPC_CIDRS6=$(imds "network/interfaces/macs/$MAC/vpc-ipv6-cidr-blocks" 2>/dev/null | paste -sd, - || true)
  [ -n "$VPC_CIDRS" ] || die "could not read the VPC CIDR from instance metadata"
else
  # No instance role holds anything of TNP's here (Lightsail), so there is no
  # credential for the metadata service to leak; peers and every TNP service
  # are blocked from it regardless (nftables, IPAddressDeny).
  [ "$IMDS_V1" -eq 0 ] || echo "tnp-exit bootstrap: note: IMDSv1 answers; peers and services are blocked from it" >&2
  if [ "$HAVE_IMDS" -eq 1 ]; then
    MAC=$(imds mac 2>/dev/null || true)
    [ -n "$MAC" ] && VPC_CIDRS=$(imds "network/interfaces/macs/$MAC/vpc-ipv4-cidr-blocks" 2>/dev/null | paste -sd, - || true)
  fi
fi

# --- Logs stay in memory ----------------------------------------------------
# Nothing here logs traffic, but the journal is also kept off disk and small, so
# a seized or snapshotted volume holds no agent or kernel log history.
install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/90-tnp-exit.conf <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=64M
ForwardToSyslog=no
EOF
systemctl restart systemd-journald
rm -rf /var/log/journal

# --- Bun, pinned and verified -----------------------------------------------
install -d -m 0755 "$ROOT" "$ROOT/bin"
if ! "$ROOT/bin/bun" --version 2>/dev/null | grep -qx "$BUN_VERSION"; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/bun.zip" \
    "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-$BUN_ARCH.zip"
  echo "$BUN_SHA256  $tmp/bun.zip" | sha256sum -c -
  unzip -q "$tmp/bun.zip" -d "$tmp"
  install -m 0755 "$tmp/bun-linux-$BUN_ARCH/bun" "$ROOT/bin/bun"
  rm -rf "$tmp"
fi

# --- The agent and the resolver, at exactly the pinned commit ---------------
if [ ! -d "$ROOT/src/.git" ]; then
  rm -rf "$ROOT/src"
  git init -q "$ROOT/src"
fi
git -C "$ROOT/src" fetch -q --depth 1 "$REPO" "$TNP_EXIT_COMMIT"
git -C "$ROOT/src" checkout -q --force --detach FETCH_HEAD
[ "$(git -C "$ROOT/src" rev-parse HEAD)" = "$TNP_EXIT_COMMIT" ] || die "checkout is not $TNP_EXIT_COMMIT"
# Production dependencies of the agent's and the resolver's graphs only, exactly
# as locked. @tnp/client is listed because apps/dns-server imports it by
# relative path (audit B1), as Dockerfile.dns does.
(cd "$ROOT/src" && "$ROOT/bin/bun" install --frozen-lockfile --production --omit=peer \
  --filter @tnp/exit --filter @tnp/dns-server --filter @tnp/client)
chown -R root:root "$ROOT"
chmod -R go-w "$ROOT"
chmod 0755 "$ROOT/src/apps/exit/deploy/wg-up.sh"

# On-disk secrets are checked now, before anything is installed around them.
if [ "$TNP_EXIT_SECRETS" = file ]; then
  # shellcheck source=secrets.sh
  . "$ROOT/src/apps/exit/deploy/secrets.sh"
  check_file_secrets "$TNP_EXIT_SECRETS_DIR" 0 ||
    die "copy the secrets to $TNP_EXIT_SECRETS_DIR first (exit-nodes.md §9.8)"
fi

id tnp-exit >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tnp-exit
id tnp-exit-dns >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tnp-exit-dns

# --- Settings ---------------------------------------------------------------
install -d -m 0755 /etc/tnp-exit
cat >/etc/tnp-exit/exit.env <<EOF
TNP_EXIT_SECRETS=$TNP_EXIT_SECRETS
AWS_REGION=$AWS_REGION
TNP_EXIT_SSM_PREFIX=$TNP_EXIT_SSM_PREFIX
EOF
cat >/etc/tnp-exit/agent.env <<EOF
TNP_API_URL=$TNP_API_URL
TNP_EXIT_INTERFACE=wg0
TNP_EXIT_UPLINK=$UPLINK
TNP_EXIT_MONTHLY_CAP_GB=$TNP_EXIT_MONTHLY_CAP_GB
TNP_EXIT_THROTTLE_MBIT=$TNP_EXIT_THROTTLE_MBIT
EOF
cat >/etc/tnp-exit/dns.env <<EOF
TNP_API_URL=$TNP_API_URL
TNP_UPSTREAM_DNS=$TNP_EXIT_DNS_UPSTREAM
EOF
chmod 0644 /etc/tnp-exit/exit.env /etc/tnp-exit/agent.env /etc/tnp-exit/dns.env

# --- Packet filter (forwarding is switched on later, by wg-up.sh) -----------
install -d -m 0755 /etc/nftables
nft_args=(--wg wg0 --uplink "$UPLINK" --uplink-address "$UPLINK_ADDRS" --local-dns "$GATEWAY4")
[ -n "$VPC_CIDRS" ] && nft_args+=(--operator-cidr "$VPC_CIDRS")
[ -n "$VPC_CIDRS6" ] && nft_args+=(--operator-cidr "$VPC_CIDRS6")
[ -n "$TNP_VPN_DNS" ] && nft_args+=(--dns "$TNP_VPN_DNS")
[ -n "$TNP_EXIT_SSH_FROM" ] && nft_args+=(--admin-ssh "$TNP_EXIT_SSH_FROM")
"$ROOT/bin/bun" --no-install "$ROOT/src/apps/exit/src/cli.ts" nftables "${nft_args[@]}" \
  >/etc/nftables/tnp-exit.nft.new
nft -c -f /etc/nftables/tnp-exit.nft.new || die "generated ruleset refused by nft; nothing loaded"
mv -f /etc/nftables/tnp-exit.nft.new /etc/nftables/tnp-exit.nft
# Replaces the distribution's default ruleset file (Debian's flushes the whole
# ruleset and accepts everything): only TNP's table is loaded at boot.
printf '#!/usr/sbin/nft -f\ninclude "/etc/nftables/tnp-exit.nft"\n' >"$(nftables_conf "$PKG")"
systemctl enable nftables
systemctl restart nftables
nft list table inet tnp_exit >/dev/null || die "ruleset did not load"

# No ip_forward here: wg-up.sh switches forwarding on only after verifying the
# packet filter is loaded, and off again on failure or stop.
cat >/etc/sysctl.d/90-tnp-exit.conf <<'EOF'
net.ipv4.ip_forward = 0
net.ipv6.conf.all.forwarding = 0
# Forwarding (switched on by wg-up.sh) would otherwise switch off the kernel's
# acceptance of router advertisements on the uplink.
net.ipv6.conf.all.accept_ra = 2
net.ipv6.conf.default.accept_ra = 2
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
EOF
sysctl --system >/dev/null

# --- Services ---------------------------------------------------------------
# A resolver already on port 53 of every address (systemd-resolved's stub binds
# 127.0.0.53 only, which does not conflict) is the operator's to remove.
install -m 0644 "$ROOT/src/apps/exit/deploy/tnp-exit-wg.service" /etc/systemd/system/
install -m 0644 "$ROOT/src/apps/exit/deploy/tnp-exit-agent.service" /etc/systemd/system/
install -m 0644 "$ROOT/src/apps/exit/deploy/tnp-exit-dns.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable tnp-exit-wg.service tnp-exit-agent.service tnp-exit-dns.service
# wg0 first: the agent configures it and the resolver binds its gateway address.
systemctl restart tnp-exit-wg.service
systemctl restart tnp-exit-agent.service
systemctl restart tnp-exit-dns.service

echo "tnp-exit bootstrap: $TNP_EXIT_ID running commit $TNP_EXIT_COMMIT on $UPLINK (secrets: $TNP_EXIT_SECRETS); resolver on $GATEWAY4"
