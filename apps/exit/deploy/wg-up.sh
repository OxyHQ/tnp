#!/bin/sh
# Bring up wg0 on a TNP exit, as root, at every boot (tnp-exit-wg.service).
#
# The exit's WireGuard private key and the agent's API token are read from
# SSM Parameter Store with the instance role, into /run (tmpfs), and never
# written to persistent storage, user-data or the AMI. The private key file is
# deleted as soon as the kernel has it; the token file stays in /run for
# systemd to hand to the agent as a credential, readable by root only.
#
# Forwarding is switched on HERE, last, and only once the packet filter is
# verified loaded — never by sysctl.d at boot, where it could come up before
# the filter. Any failure switches it back off.
#
# Settings come from /etc/tnp-exit/exit.env, written by bootstrap.sh:
#   AWS_REGION, TNP_EXIT_SSM_PREFIX
set -eu

. /etc/tnp-exit/exit.env
: "${AWS_REGION:?}" "${TNP_EXIT_SSM_PREFIX:?}"

IFACE=wg0
PORT=51820
ADDR4=10.77.0.1/16
ADDR6=fd85:d596:af02::1/64
RUN=/run/tnp-exit

forwarding() {
  sysctl -q -w "net.ipv4.ip_forward=$1" "net.ipv6.conf.all.forwarding=$1"
}

umask 077
mkdir -p "$RUN"
chmod 0700 "$RUN"
KEY="$RUN/wg.key"
ok=0
cleanup() {
  rm -f "$KEY" "$RUN/agent-token.new"
  if [ "$ok" -ne 1 ]; then
    forwarding 0 || true
    ip link del "$IFACE" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Nothing is forwarded until this exits successfully.
forwarding 0
if ! nft list table inet tnp_exit >/dev/null 2>&1; then
  echo "tnp-exit: the tnp_exit packet filter is not loaded; refusing to bring up $IFACE" >&2
  exit 1
fi

# SSM can be briefly unreachable while the network comes up: retry, then fail.
get_parameter() {
  attempt=1
  while :; do
    if aws ssm get-parameter --region "$AWS_REGION" --with-decryption \
      --name "$1" --query Parameter.Value --output text >"$2"; then
      return 0
    fi
    [ "$attempt" -ge 10 ] && return 1
    attempt=$((attempt + 1))
    sleep 3
  done
}

get_parameter "$TNP_EXIT_SSM_PREFIX/wg-private-key" "$KEY"
if ! grep -Eqx '[A-Za-z0-9+/]{43}=' "$KEY"; then
  echo "tnp-exit: $TNP_EXIT_SSM_PREFIX/wg-private-key is not a WireGuard key" >&2
  exit 1
fi

get_parameter "$TNP_EXIT_SSM_PREFIX/agent-token" "$RUN/agent-token.new"
# At least 43 base64url characters (256 bits); the agent also refuses
# visibly low-entropy values (isStrongExitToken).
if ! grep -Eqx '[A-Za-z0-9_-]{43,512}' "$RUN/agent-token.new"; then
  echo "tnp-exit: $TNP_EXIT_SSM_PREFIX/agent-token must be at least 43 base64url characters" >&2
  exit 1
fi
mv -f "$RUN/agent-token.new" "$RUN/agent-token"

ip link del "$IFACE" 2>/dev/null || true
ip link add "$IFACE" type wireguard
wg set "$IFACE" listen-port "$PORT" private-key "$KEY"
rm -f "$KEY"
ip -4 address add "$ADDR4" dev "$IFACE"
ip -6 address add "$ADDR6" dev "$IFACE"
ip link set "$IFACE" mtu 1420 up

# Established TCP flows are forgotten after an hour idle instead of five days,
# so connection-tracking state about a device does not outlive it for long.
sysctl -q -w net.netfilter.nf_conntrack_tcp_timeout_established=3600

# Last: the filter was verified above and is required by this unit.
nft list table inet tnp_exit >/dev/null
forwarding 1
ok=1

# The public key is public: printed so an operator can check it against TNP_VPN_EXITS.
echo "tnp-exit: $IFACE up on UDP $PORT, public key $(wg show "$IFACE" public-key)"
