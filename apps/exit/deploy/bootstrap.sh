#!/bin/bash
# Turn a fresh Amazon Linux 2023 (arm64) EC2 instance into a TNP WireGuard exit.
#
# Run once, as root, from user-data (docs/architecture/exit-nodes.md §9 has the
# full procedure and the infrastructure it expects). Idempotent: re-running it
# with a new TNP_EXIT_COMMIT upgrades the agent in place, though replacing the
# instance is the preferred upgrade — the identity lives in SSM, not on disk.
#
# Inputs (environment). None of them is secret:
#   TNP_EXIT_ID          required. Short id matching TNP_VPN_EXITS, e.g. usw2-1.
#   TNP_EXIT_COMMIT      required. Full 40-hex commit of OxyHQ/tnp to run.
#   TNP_API_URL          default https://api.tnp.network
#   TNP_VPN_DNS          resolver IPs device configs use (same value as the
#                        API's); DNS to them is rate-limited per peer.
#   TNP_EXIT_SSM_PREFIX  default /tnp/exit/$TNP_EXIT_ID. Holds two SecureStrings:
#                        <prefix>/wg-private-key  and  <prefix>/agent-token.
#
# What it never does: write a secret to disk, enable any log of traffic, or
# open anything to the internet but UDP 51820.
set -euo pipefail

BUN_VERSION=1.4.3
# sha256 of bun-linux-aarch64.zip for $BUN_VERSION, from the release's SHASUMS256.txt.
BUN_SHA256=efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21
REPO=https://github.com/OxyHQ/tnp.git
ROOT=/opt/tnp-exit

die() { echo "tnp-exit bootstrap: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root"
[ "$(uname -m)" = aarch64 ] || die "expects arm64 (aarch64)"

: "${TNP_EXIT_ID:?TNP_EXIT_ID is required}"
: "${TNP_EXIT_COMMIT:?TNP_EXIT_COMMIT is required}"
TNP_API_URL="${TNP_API_URL:-https://api.tnp.network}"
TNP_VPN_DNS="${TNP_VPN_DNS:-}"
TNP_EXIT_SSM_PREFIX="${TNP_EXIT_SSM_PREFIX:-/tnp/exit/$TNP_EXIT_ID}"

[[ "$TNP_EXIT_ID" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "TNP_EXIT_ID must be lowercase letters, digits, dashes"
[[ "$TNP_EXIT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "TNP_EXIT_COMMIT must be a full 40-hex commit"
[[ "$TNP_API_URL" =~ ^https://[a-z0-9.-]+(:[0-9]+)?$ ]] || die "TNP_API_URL must be https://host"
[[ "$TNP_VPN_DNS" =~ ^[0-9a-fA-F.:,]*$ ]] || die "TNP_VPN_DNS must be a comma list of IPs"
[[ "$TNP_EXIT_SSM_PREFIX" =~ ^/[A-Za-z0-9/_.-]+$ ]] || die "TNP_EXIT_SSM_PREFIX is not an SSM path"

# --- Packages ---------------------------------------------------------------
dnf install -y wireguard-tools nftables conntrack-tools git unzip
command -v aws >/dev/null || dnf install -y awscli-2

# --- Instance facts (IMDSv2) ------------------------------------------------
imds() {
  local token
  token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
  curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}
# IMDSv2 must be REQUIRED: with v1 allowed, anything that can make the host
# issue a plain GET (a confused process, a forwarded request) can read the
# instance role's credentials, which unlock the exit's private key in SSM.
if curl -fsS -m 3 -o /dev/null http://169.254.169.254/latest/meta-data/ 2>/dev/null; then
  die "IMDSv1 answers on this instance; require IMDSv2 (HttpTokens=required, hop limit 1) and relaunch"
fi
AWS_REGION=$(imds placement/region)
MAC=$(imds mac)
VPC_CIDRS=$(imds "network/interfaces/macs/$MAC/vpc-ipv4-cidr-blocks" | paste -sd, -)
VPC_CIDRS6=$(imds "network/interfaces/macs/$MAC/vpc-ipv6-cidr-blocks" 2>/dev/null | paste -sd, - || true)
UPLINK=$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
[ -n "$UPLINK" ] || die "no default route"
[ -n "$VPC_CIDRS" ] || die "could not read the VPC CIDR from instance metadata"

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
    "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-aarch64.zip"
  echo "$BUN_SHA256  $tmp/bun.zip" | sha256sum -c -
  unzip -q "$tmp/bun.zip" -d "$tmp"
  install -m 0755 "$tmp/bun-linux-aarch64/bun" "$ROOT/bin/bun"
  rm -rf "$tmp"
fi

# --- The agent, at exactly the pinned commit --------------------------------
if [ ! -d "$ROOT/src/.git" ]; then
  rm -rf "$ROOT/src"
  git init -q "$ROOT/src"
fi
git -C "$ROOT/src" fetch -q --depth 1 "$REPO" "$TNP_EXIT_COMMIT"
git -C "$ROOT/src" checkout -q --force --detach FETCH_HEAD
[ "$(git -C "$ROOT/src" rev-parse HEAD)" = "$TNP_EXIT_COMMIT" ] || die "checkout is not $TNP_EXIT_COMMIT"
# Production dependencies of the agent's graph only, exactly as locked.
(cd "$ROOT/src" && "$ROOT/bin/bun" install --frozen-lockfile --production --omit=peer --filter @tnp/exit)
chown -R root:root "$ROOT"
chmod -R go-w "$ROOT"
chmod 0755 "$ROOT/src/apps/exit/deploy/wg-up.sh"

id tnp-exit >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin tnp-exit

# --- Settings ---------------------------------------------------------------
install -d -m 0755 /etc/tnp-exit
cat >/etc/tnp-exit/exit.env <<EOF
AWS_REGION=$AWS_REGION
TNP_EXIT_SSM_PREFIX=$TNP_EXIT_SSM_PREFIX
EOF
cat >/etc/tnp-exit/agent.env <<EOF
TNP_API_URL=$TNP_API_URL
TNP_EXIT_INTERFACE=wg0
EOF
chmod 0644 /etc/tnp-exit/exit.env /etc/tnp-exit/agent.env

# --- Packet filter (forwarding is switched on later, by wg-up.sh) -----------
install -d -m 0755 /etc/nftables
operator_args=(--operator-cidr "$VPC_CIDRS")
[ -n "$VPC_CIDRS6" ] && operator_args+=(--operator-cidr "$VPC_CIDRS6")
dns_args=()
[ -n "$TNP_VPN_DNS" ] && dns_args=(--dns "$TNP_VPN_DNS")
"$ROOT/bin/bun" --no-install "$ROOT/src/apps/exit/src/cli.ts" nftables \
  --wg wg0 --uplink "$UPLINK" "${operator_args[@]}" "${dns_args[@]}" >/etc/nftables/tnp-exit.nft.new
nft -c -f /etc/nftables/tnp-exit.nft.new || die "generated ruleset refused by nft; nothing loaded"
mv -f /etc/nftables/tnp-exit.nft.new /etc/nftables/tnp-exit.nft
echo 'include "/etc/nftables/tnp-exit.nft"' >/etc/sysconfig/nftables.conf
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
install -m 0644 "$ROOT/src/apps/exit/deploy/tnp-exit-wg.service" /etc/systemd/system/
install -m 0644 "$ROOT/src/apps/exit/deploy/tnp-exit-agent.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable tnp-exit-wg.service tnp-exit-agent.service
systemctl restart tnp-exit-wg.service
systemctl restart tnp-exit-agent.service

echo "tnp-exit bootstrap: $TNP_EXIT_ID running commit $TNP_EXIT_COMMIT on $UPLINK"
