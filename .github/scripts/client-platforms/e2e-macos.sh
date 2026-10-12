#!/usr/bin/env bash
# End-to-end test of the compiled TNP client on a real macOS machine, as root.
# Run by .github/workflows/client-platforms.yml on a throwaway runner:
#
#   sudo env TNP_BIN=<compiled tnp> BUN=<bun> E2E_LOG_DIR=<dir> bash e2e-macos.sh
#
# It installs the LaunchDaemon, changes pf and /etc/resolver, and removes them
# again; do not run it on a machine you care about.
set -euo pipefail

: "${TNP_BIN:?TNP_BIN must name the compiled tnp binary}"
: "${BUN:?BUN must name the bun binary (for the fake API)}"
: "${E2E_LOG_DIR:?E2E_LOG_DIR must name a directory for logs}"

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$E2E_LOG_DIR"
mkdir -p "$LOG"
chmod 755 "$LOG"

PORT=18080
NAME=e2e.ox
ADDR=203.0.113.7
INSTALLED_BIN=/usr/local/bin/tnp
CONFIG_DIR=/usr/local/etc/tnp
STATE_DIR="/Library/Application Support/tnp"
LABEL=so.oxy.tnp.resolver
PLIST="/Library/LaunchDaemons/$LABEL.plist"
ANCHOR=com.apple/tnp-killswitch
INSTALLED_RESOLVER=$'nameserver 127.0.0.1\nport 53'

API_PID=""
CONNECT_PID=""

fail() { echo "::error::$*"; exit 1; }
pass() { echo "PASS $*"; }
group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }

diagnostics() {
  {
    echo "== launchctl print system/$LABEL"; launchctl print "system/$LABEL" 2>&1 || true
    echo "== /etc/resolver"; ls -la /etc/resolver 2>&1 || true
    for f in /etc/resolver/*; do [ -f "$f" ] && { echo "-- $f"; cat "$f"; }; done
    echo "== pfctl -s info"; pfctl -s info 2>&1 || true
    echo "== pfctl -s References"; pfctl -s References 2>&1 || true
    echo "== pfctl -s rules"; pfctl -s rules 2>&1 || true
    echo "== pfctl -a $ANCHOR -s rules"; pfctl -a "$ANCHOR" -s rules 2>&1 || true
    echo "== processes"; pgrep -fl tnp || true
  } > "$LOG/diagnostics.txt" 2>&1
  scutil --dns > "$LOG/scutil-dns-final.txt" 2>&1 || true
  [ -f /var/log/tnp-resolver.log ] && cp /var/log/tnp-resolver.log "$LOG/" || true
}

cleanup() {
  status=$?
  [ -n "$CONNECT_PID" ] && kill -9 "$CONNECT_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    diagnostics
    echo "::error::macOS end-to-end failed (exit $status); see the uploaded logs"
  fi
  chmod -R a+rX "$LOG" 2>/dev/null || true
}
trap cleanup EXIT

[ "$(id -u)" = 0 ] || fail "run this as root"

# ── Probes ──────────────────────────────────────────────────────────────────

# File name and SHA-256 of every /etc/resolver entry, sorted.
resolver_snapshot() {
  [ -d /etc/resolver ] || return 0
  find /etc/resolver -mindepth 1 -maxdepth 1 -print0 | sort -z | while IFS= read -r -d '' f; do
    printf '%s %s\n' "$(basename "$f")" "$(shasum -a 256 < "$f" | cut -c1-64)"
  done
}

# The DNS servers set on every network service (what a "capture all DNS" bug
# would change).
service_dns_snapshot() {
  networksetup -listallnetworkservices | tail -n +2 | sed 's/^\*//' | while IFS= read -r svc; do
    printf '%s: %s\n' "$svc" "$(networksetup -getdnsservers "$svc" | tr '\n' ' ')"
  done
}

# The resolvers macOS uses for names no scoped resolver claims.
default_resolvers() {
  scutil --dns | awk '/^DNS configuration$/{on=1} /^DNS configuration \(for scoped/{on=0} on && /^resolver #1$/{r=1;next} on && /^resolver #/{r=0} on && r && /nameserver\[/{print $3}'
}

pf_status() { pfctl -s info 2>/dev/null | awk '/^Status:/{print $2}'; }
anchor_rules() { pfctl -a "$ANCHOR" -s rules 2>/dev/null || true; }

# Plain DNS to a public resolver; succeeds only if an answer came back.
public_dns_works() {
  local out
  out="$(dig "$@" @1.1.1.1 example.com A +time=2 +tries=1 +short 2>&1)" || return 1
  printf '%s\n' "$out" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
}

wait_for() {
  local what="$1" tries="$2"; shift 2
  for _ in $(seq 1 "$tries"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}

flush_dns_cache() { dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null || true; }

system_resolves_e2e() {
  dscacheutil -q host -a name "$NAME" | grep -q "ip_address: $ADDR"
}

file_mode() { stat -f '%Su:%Sg %Lp' "$1"; }

set_listen_port() {
  python3 -I -c 'import json,sys; p=sys.argv[1]; c=json.load(open(p)); c["listenPort"]=int(sys.argv[2]); json.dump(c, open(p,"w"), indent=2)' \
    "$CONFIG_DIR/config.json" "$1"
}

# Start `tnp connect` with the given flags in the background, wait for it to be
# ready, and leave its pid in CONNECT_PID.
start_connect() {
  local log="$1"; shift
  "$TNP_BIN" connect "$@" > "$log" 2>&1 &
  CONNECT_PID=$!
  for _ in $(seq 1 60); do
    if grep -q "overlay client ready" "$log"; then return 0; fi
    if ! kill -0 "$CONNECT_PID" 2>/dev/null; then
      cat "$log"
      fail "tnp connect $* exited before it was ready"
    fi
    sleep 1
  done
  cat "$log"
  fail "tnp connect $* was not ready within 60s"
}

# ── Before ──────────────────────────────────────────────────────────────────

group "Record the DNS and pf state before install"
sw_vers
resolvers_before="$(resolver_snapshot)"
services_before="$(service_dns_snapshot)"
defaults_before="$(default_resolvers)"
pf_before="$(pf_status)"
scutil --dns > "$LOG/scutil-dns-before.txt"
pfctl -s rules > "$LOG/pf-rules-before.txt" 2>&1 || true
echo "resolver files: ${resolvers_before:-<none>}"
echo "service DNS:"; echo "$services_before"
echo "default resolvers: $defaults_before"
echo "pf: $pf_before"
public_dns_works || fail "plain DNS to 1.1.1.1 does not work on this runner even before TNP"
[ -z "$(anchor_rules)" ] || fail "the kill-switch anchor already has rules before install"
endgroup

group "Start the fake TNP API"
"$BUN" "$HERE/fake-api.ts" "$PORT" "$LOG/api-requests.log" > "$LOG/fake-api.log" 2>&1 &
API_PID=$!
wait_for "the fake API" 30 curl -fsS "http://127.0.0.1:$PORT/health"
# The config tnp install reads; only the API is changed from the defaults.
install -d -m 700 -o root -g wheel "$CONFIG_DIR"
(umask 077; printf '{\n  "apiBaseUrl": "http://127.0.0.1:%s"\n}\n' "$PORT" > "$CONFIG_DIR/config.json")
endgroup

# ── Install ─────────────────────────────────────────────────────────────────

group "tnp install"
for dir in /usr /usr/local /usr/local/bin; do
  [ -d "$dir" ] && echo "$dir: $(file_mode "$dir")"
done
if ! "$TNP_BIN" install > "$LOG/install.log" 2>&1; then
  cat "$LOG/install.log"
  # The installer refuses a /usr/local/bin a non-root user could write (what an
  # Intel Homebrew prefix looks like). That refusal is correct; prove nothing
  # was installed, then make the directory root's and install for real.
  grep -q "is not root-owned or is writable by other users" "$LOG/install.log" ||
    fail "tnp install failed"
  [ ! -e "$PLIST" ] || fail "a refused install still wrote $PLIST"
  echo "::notice::tnp install refused this runner's user-writable /usr/local/bin, as designed; making it root-owned and retrying"
  for dir in /usr/local /usr/local/bin; do
    chown root:wheel "$dir"
    chmod go-w "$dir"
  done
  "$TNP_BIN" install > "$LOG/install.log" 2>&1 || { cat "$LOG/install.log"; fail "tnp install failed"; }
fi
cat "$LOG/install.log"
endgroup

group "The LaunchDaemon runs the root-owned copy"
[ -f "$PLIST" ] || fail "$PLIST was not written"
[ "$(file_mode "$PLIST")" = "root:wheel 644" ] || fail "$PLIST is $(file_mode "$PLIST"), expected root:wheel 644"
program="$(plutil -extract ProgramArguments.0 raw "$PLIST")"
[ "$program" = "$INSTALLED_BIN" ] || fail "the LaunchDaemon runs $program, not $INSTALLED_BIN"
[ "$(file_mode "$INSTALLED_BIN")" = "root:wheel 755" ] ||
  fail "$INSTALLED_BIN is $(file_mode "$INSTALLED_BIN"), expected root:wheel 755"
cmp -s "$TNP_BIN" "$INSTALLED_BIN" || fail "$INSTALLED_BIN is not a copy of the binary that ran install"
wait_for "the LaunchDaemon to be running" 30 sh -c "launchctl print system/$LABEL | grep -q 'state = running'"
pid="$(launchctl print "system/$LABEL" | awk '/^\tpid = /{print $3}')"
[ -n "$pid" ] || fail "no pid for $LABEL"
[ "$(ps -o user= -p "$pid" | tr -d ' ')" = "root" ] || fail "the resolver does not run as root"
ps -o command= -p "$pid" | grep -q "^$INSTALLED_BIN run" || fail "the resolver process is not $INSTALLED_BIN run"
"$TNP_BIN" status | tee "$LOG/status-installed.log"
pass "LaunchDaemon $LABEL runs $INSTALLED_BIN as root (pid $pid)"
endgroup

group "Only .ox is routed, through /etc/resolver/ox"
[ "$(cat /etc/resolver/ox)" = "$INSTALLED_RESOLVER" ] || { cat /etc/resolver/ox; fail "/etc/resolver/ox is not what install writes"; }
others_now="$(resolver_snapshot | grep -v '^ox ' || true)"
[ "$others_now" = "$(printf '%s\n' "$resolvers_before" | grep -v '^ox ' || true)" ] ||
  fail "install changed /etc/resolver entries other than ox"
scutil --dns > "$LOG/scutil-dns-installed.txt"
grep -A4 'domain   : ox$' "$LOG/scutil-dns-installed.txt" | grep -q 'nameserver\[0\] : 127.0.0.1' ||
  fail "scutil --dns shows no scoped resolver for ox -> 127.0.0.1"
[ "$(default_resolvers)" = "$defaults_before" ] || fail "install changed the default resolvers"
[ "$(service_dns_snapshot)" = "$services_before" ] || fail "install changed a network service's DNS servers"
pass "scoped resolver for .ox only; default resolvers unchanged ($defaults_before)"
endgroup

group "The system resolver answers .ox from TNP, and public names as before"
wait_for "the resolver to answer on 127.0.0.1:53" 30 sh -c "dig @127.0.0.1 $NAME A +short +time=2 +tries=1 | grep -qx $ADDR"
flush_dns_cache
wait_for "dscacheutil to resolve $NAME" 20 system_resolves_e2e
dscacheutil -q host -a name "$NAME"
grep -q "/dns/resolve?name=$NAME" "$LOG/api-requests.log" || fail "the fake API never saw a lookup of $NAME"
public="$(dscacheutil -q host -a name example.com)"
echo "$public"
printf '%s\n' "$public" | grep -q 'ip_address: ' || fail "example.com does not resolve through the system resolver"
printf '%s\n' "$public" | grep -q "$ADDR" && fail "example.com resolved to the TNP test answer"
grep -q "name=example.com" "$LOG/api-requests.log" && fail "a public name was sent to the TNP API"
pass "$NAME -> $ADDR via the fake API; example.com via the normal resolvers"
endgroup

group "Config and state are root-only"
echo "$CONFIG_DIR: $(file_mode "$CONFIG_DIR")"
[ "$(file_mode "$CONFIG_DIR/config.json")" = "root:wheel 600" ] ||
  fail "config.json is $(file_mode "$CONFIG_DIR/config.json"), expected root:wheel 600"
mode="$(stat -f '%Lp' "$CONFIG_DIR")"
[ $((8#$mode & 8#007)) -eq 0 ] || fail "$CONFIG_DIR is mode $mode: other users can enter it"
[ "$(stat -f '%Su' "$CONFIG_DIR")" = root ] || fail "$CONFIG_DIR is not root-owned"
[ "$(file_mode "$STATE_DIR")" = "root:wheel 700" ] || fail "$STATE_DIR is $(file_mode "$STATE_DIR"), expected root:wheel 700"
pass "config.json root 0600, $CONFIG_DIR mode $mode, state dir root 0700"
endgroup

# ── Kill switch ─────────────────────────────────────────────────────────────

# `tnp connect` runs its own resolver; the installed one holds port 53.
set_listen_port 5354

group "Kill switch refuses, leaving nothing, when pf would not evaluate it"
pfctl -s rules 2>/dev/null | grep -q '^anchor "com.apple/\*"' ||
  fail "the stock pf ruleset with anchor \"com.apple/*\" is not loaded on this runner"
# A main ruleset without the com.apple anchor: the anchor's rules would never
# be evaluated, so connect must refuse and roll back.
echo "pass all" | pfctl -f - 2>/dev/null
if "$TNP_BIN" connect --killswitch > "$LOG/connect-refused.log" 2>&1; then
  cat "$LOG/connect-refused.log"; fail "connect --killswitch ran although pf would not evaluate its anchor"
fi
cat "$LOG/connect-refused.log"
grep -q 'kill switch could not be applied' "$LOG/connect-refused.log" || fail "no refusal message"
grep -q 'com.apple/\*' "$LOG/connect-refused.log" || fail "the refusal does not name the missing anchor"
[ -z "$(anchor_rules)" ] || fail "a refused kill switch left rules in $ANCHOR"
[ "$(pf_status)" = "$pf_before" ] || fail "a refused kill switch left pf $(pf_status) (was $pf_before)"
[ ! -e "$STATE_DIR/killswitch.json" ] || fail "a refused kill switch left a record"
pfctl -f /etc/pf.conf 2>/dev/null
pass "refused with no rules, pf $pf_before as before, no record"
endgroup

group "Kill switch on: plain DNS to public resolvers blocked, loopback not"
start_connect "$LOG/connect-1.log" --killswitch
cat "$LOG/connect-1.log"
rules="$(anchor_rules)"
echo "$rules"
printf '%s\n' "$rules" | grep -q 'block drop out quick proto tcp from any to any port = 53' || fail "no TCP block rule"
printf '%s\n' "$rules" | grep -q 'block drop out quick proto udp from any to any port = 53' || fail "no UDP block rule"
printf '%s\n' "$rules" | grep -q 'pass out quick inet6 proto udp from any to ::1 port = 53' || fail "no IPv6 loopback pass rule"
[ "$(pf_status)" = "Enabled" ] || fail "pf is not enabled while the kill switch is on"
pfctl -s References 2>/dev/null || true
[ "$(file_mode "$STATE_DIR/killswitch.json")" = "root:wheel 600" ] || fail "kill-switch record is not root 0600"
grep -q '"pfToken"' "$STATE_DIR/killswitch.json" || fail "the kill-switch record holds no pf token"
if public_dns_works; then fail "plain UDP DNS to 1.1.1.1 still works with the kill switch on"; fi
if public_dns_works +tcp; then fail "plain TCP DNS to 1.1.1.1 still works with the kill switch on"; fi
dig @127.0.0.1 "$NAME" A +short +time=2 +tries=1 | grep -qx "$ADDR" || fail "loopback DNS (installed resolver) is blocked"
dig @127.0.0.1 -p 5354 "$NAME" A +short +time=2 +tries=1 | grep -qx "$ADDR" || fail "loopback DNS (connect's resolver) is blocked"
pass "UDP and TCP DNS to 1.1.1.1 blocked; 127.0.0.1:53 and :5354 answer"
endgroup

group "Kill switch off on a clean stop"
kill -INT "$CONNECT_PID"
code=0; wait "$CONNECT_PID" || code=$?
CONNECT_PID=""
cat "$LOG/connect-1.log"
[ "$code" = 0 ] || fail "tnp connect exited $code on SIGINT"
[ -z "$(anchor_rules)" ] || fail "rules remain in $ANCHOR after a clean stop"
[ "$(pf_status)" = "$pf_before" ] || fail "pf is $(pf_status) after the kill switch, was $pf_before"
[ ! -e "$STATE_DIR/killswitch.json" ] || fail "the kill-switch record outlived the rules"
[ "$(cat /etc/resolver/ox)" = "$INSTALLED_RESOLVER" ] || fail "connect did not give /etc/resolver/ox back to the installed resolver"
wait_for "plain DNS to 1.1.1.1 to work again" 10 public_dns_works
pass "no rules, pf $pf_before again, DNS to 1.1.1.1 works, installed routing restored"
endgroup

group "Kill switch stays on when connect crashes (fail closed)"
start_connect "$LOG/connect-2.log" --killswitch
kill -9 "$CONNECT_PID"
wait "$CONNECT_PID" 2>/dev/null || true
CONNECT_PID=""
[ -n "$(anchor_rules)" ] || fail "the kill-switch rules vanished when connect crashed"
[ "$(pf_status)" = "Enabled" ] || fail "pf was disabled when connect crashed"
[ -e "$STATE_DIR/killswitch.json" ] || fail "the kill-switch record vanished when connect crashed"
if public_dns_works; then fail "plain DNS to 1.1.1.1 works after a crash with the kill switch on"; fi
pass "rules, pf token and record survive a crash; DNS to 1.1.1.1 still blocked (uninstall must clear them)"
endgroup

cp /var/log/tnp-resolver.log "$LOG/" 2>/dev/null || true

# ── Uninstall ───────────────────────────────────────────────────────────────

group "tnp uninstall --purge"
"$TNP_BIN" uninstall --purge 2>&1 | tee "$LOG/uninstall.log"
[ "${PIPESTATUS[0]}" = 0 ] || fail "tnp uninstall --purge failed"
endgroup

group "Nothing of TNP is left, and DNS is exactly as before"
[ ! -e "$PLIST" ] || fail "$PLIST is still there"
launchctl print "system/$LABEL" >/dev/null 2>&1 && fail "$LABEL is still loaded"
wait_for "the resolver process to exit" 15 sh -c "! pgrep -f '$INSTALLED_BIN run'"
[ ! -e "$INSTALLED_BIN" ] || fail "$INSTALLED_BIN is still there"
[ "$(resolver_snapshot)" = "$resolvers_before" ] || {
  resolver_snapshot; fail "/etc/resolver differs from before install"
}
scutil --dns > "$LOG/scutil-dns-after.txt"
grep -q 'domain   : ox$' "$LOG/scutil-dns-after.txt" && fail "scutil --dns still has a resolver for ox"
[ "$(default_resolvers)" = "$defaults_before" ] || fail "the default resolvers differ from before install"
[ "$(service_dns_snapshot)" = "$services_before" ] || fail "a network service's DNS servers differ from before install"
[ -z "$(anchor_rules)" ] || fail "rules remain in $ANCHOR after uninstall"
[ "$(pf_status)" = "$pf_before" ] || fail "pf is $(pf_status) after uninstall, was $pf_before"
wait_for "plain DNS to 1.1.1.1 to work again" 10 public_dns_works
for path in "$CONFIG_DIR" "$STATE_DIR" /var/log/tnp-resolver.log; do
  [ ! -e "$path" ] || fail "$path is still there after --purge"
done
for home in /var/root "/Users/${SUDO_USER:-runner}"; do
  for f in identity.key tlds.json dns-routing-install.json dns-routing-connect.json; do
    [ ! -e "$home/Library/Application Support/tnp/$f" ] || fail "$home/Library/Application Support/tnp/$f is still there"
  done
done
"$TNP_BIN" status > "$LOG/status-uninstalled.log" 2>&1 && fail "tnp status says the resolver runs after uninstall"
pass "service, binary, routing, pf rules and files gone; resolvers, service DNS and pf as before"
endgroup

echo "macOS end-to-end: ALL PASS"
