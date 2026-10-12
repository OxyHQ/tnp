# Exit nodes

An exit node accepts traffic from TNP circuits and opens connections to the
**public internet**.

**Status: two kinds.**

- **TNP-operated WireGuard exits (standard-tier VPN): implemented, not yet
  deployed.** The host bootstrap, packet filter, peer agent, per-exit resolver
  and traffic cap are in `apps/exit`; the API side is off until `TNP_VPN_EXITS`
  names an exit (and, in production, `TNP_VPN_ALLOWED_USERS` names accounts). §9.
- **Overlay exits for TNP circuits (community operators, private tier): not
  implemented.** Phase 7. Sections 2–8 describe them.

§1 and §3 bind both kinds.

**An exit is never automatic.** Being a relay does not make a node an exit.
Separate opt-in, separate policy, separate published metadata, separate
liability.

---

## 1. What the operator sees, stated plainly

Every destination address and port, and the full content of anything not
protected by application-layer encryption.

This is inherent to the role. It is not a defect and it is not fixable by TNP.
It must appear:

- in the operator consent flow, before anyone becomes an exit,
- in the client's exit picker, before a user selects one,
- in [`privacy-model.md`](./privacy-model.md).

## 2. Responsibilities

1. Terminate the last circuit layer.
2. Resolve destination names according to the selected policy.
3. Open TCP connections; UDP where supported.
4. Enforce the published exit policy.
5. Enforce rate and resource limits.
6. Refuse destinations that would attack the operator's own network.
7. Publish capacity, approximate jurisdiction and operator terms.
8. Keep aggregate metrics only.

## 3. SSRF and private-network protection

An exit is a request-forwarding service reachable by strangers. Without these
rules it is a tool for attacking the operator's own infrastructure and the
network it sits in. All are mandatory.

**Blocked destination ranges** — checked after resolution, on the resolved
address, never only on the requested name:

| Range | |
|---|---|
| `127.0.0.0/8`, `::1/128` | Loopback |
| `10/8`, `172.16/12`, `192.168/16` | RFC 1918 |
| `100.64/10` | CGNAT |
| `169.254/16`, `fe80::/10` | Link-local |
| `fc00::/7` | Unique local |
| `224/4`, `ff00::/8` | Multicast |
| `0.0.0.0/8`, `240/4`, `::/128` | Reserved |
| Cloud metadata endpoints (`169.254.169.254`, and the IPv6 equivalents) | Credential theft |
| The operator's own configured networks | Operator-defined |

**Rebinding defence:** resolve, check, then **connect to the checked address**.
Resolving a name, checking it, and then connecting by name again lets a DNS
rebinding attack slip a private address between the two steps.

**Redirects are not followed** by the exit — it is a byte forwarder, not an HTTP
client. Redirect handling belongs to the application.

## 4. Exit policy

Published in the directory so a client can pick an exit that will accept its
traffic, rather than discovering the refusal by failing.

```
allow  tcp 80,443
allow  tcp 22
deny   tcp 25          # SMTP — spam
deny   tcp 445,139     # SMB
deny   udp *           # until UDP support exists
deny   ipv4 10.0.0.0/8
```

Defaults refuse: SMTP (25, 465, 587), SMB, and anything the operator has not
allowed. Default-deny, not default-allow.

## 5. Limits

Per circuit and per exit: concurrent connections, connection rate, bandwidth,
connection lifetime, DNS query rate. All operator-configurable within
protocol-defined bounds.

## 6. Abuse handling

- Operators publish a contact and their terms.
- Complaints are answerable **only** from what the operator is permitted to
  retain (aggregates and policy-refusal counts) — which is deliberately little.
  That limit is stated up front, in the operator onboarding, so nobody becomes an
  exit expecting to be able to answer questions they cannot.
- An operator may refuse specific identities and may withdraw the exit role at any
  time without giving up the transit role.
- Repeated abuse from an authenticated identity is handled at the identity layer
  by Oxy, not by exits retaining more data.

## 7. Client-side selection

The client chooses; the API does not choose for it.

Inputs: policy compatibility with the intended destination, health, capacity
headroom, measured latency, approximate jurisdiction, and the user's own
inclusion and exclusion lists (by operator, by jurisdiction, by node).

An exit that fails for a client is downweighted by that client immediately,
without waiting for the directory.

## 8. Honesty requirements

- The exit picker states what the exit operator can see, at the point of choice.
- No claim that traffic through an exit is anonymous.
- Traffic that was not encrypted before it entered TNP is not encrypted when it
  leaves. Say so where a user will read it.

## 9. TNP-operated WireGuard exits (standard tier)

The exits the standard-tier VPN uses ([`vpn.md`](./vpn.md) §10). Operated by
Oxy on AWS — EC2 (§9.5) or Lightsail (§9.8) — not by community operators, and
reached directly over WireGuard, not through TNP circuits. Code: `apps/exit`
(`@tnp/exit`).

**Cost never grows with use.** Three things hold an exit's bill to its fixed
price: only allowlisted accounts are served (`TNP_VPN_ALLOWED_USERS`; in
production the VPN is off until it is set), every exit throttles itself once
its monthly transfer allowance is nearly spent (§9.9), and an AWS Budgets
alert watches the spend (§9.9).

### 9.1 What the operator sees — Oxy, here

§1 applies in full, and the operator is Oxy: every destination address and
port of every device, and the content of anything not encrypted end to end,
tied (through the registry) to the account that added the device. AWS, as the
host, can observe the same traffic at the network level. This is stated on the
dashboard page where a device is added, in the user guide, and in
[`privacy-model.md`](./privacy-model.md) §8. It is why the standard tier is not
anonymity and why the dashboard points people whose safety depends on not being
identified to Tor.

### 9.2 Packet filter (enforced, `apps/exit/src/nftables.ts`)

Generated, tested against a reviewed snapshot, checked by `nft -c` before it is
loaded, and loaded **before** forwarding is switched on or `wg0` exists
(`tnp-exit-wg.service` requires `nftables.service`).

| Rule | Why |
|---|---|
| Forward only `wg0` → uplink; source must be in `10.77.0.0/16` | Peers reach the internet, never each other or anything else on the host's networks |
| Refuse every §3 range — loopback, RFC 1918, CGNAT, link-local (incl. `169.254.169.254`), ULA (incl. `fd00:ec2::254`), multicast, reserved — plus documentation, benchmarking, IPv4-mapped/NAT64/6to4 IPv6 | SSRF and metadata-credential theft (§3) |
| Refuse the VPC's own CIDRs (read from instance metadata at boot) | §3 "the operator's own configured networks" |
| Refuse TCP 25 (reset) and SMB/NetBIOS (TCP 137/139/445, UDP 137/138) | Spam and worm traffic. Mail submission (465/587) stays open: users' mail clients need it |
| Refuse all forwarded IPv6, with an ICMP error | Not carried yet; captured by every config so it cannot leak (vpn.md §10.4) |
| Per-peer DNS rate limit (50 packets/s) to the network-wide resolvers (`TNP_VPN_DNS`), checked **before** established flows are let through | All peers share the exit's address at that resolver; conntrack would otherwise wave a one-socket flood through after its first reply |
| Masquerade IPv4 out of the uplink | One public address for all peers |
| Input: only UDP 51820 on the uplink, replies, DHCP, essential ICMP | Nothing on the host is reachable from the internet — no agent port, no resolver |
| Input: UDP/TCP 53 from `wg0`, source in `10.77.0.0/16`, to the gateway address `10.77.0.1` only, rate-limited per peer (50 packets/s) | The exit's own resolver (§9.7) — the one thing on the host a peer can reach |
| Input: TCP 22 only from `TNP_EXIT_SSH_FROM`, if set | No SSH at all by default; on Lightsail (no SSM) an operator address can be allowed (§9.8) |
| Refuse the uplink's own networks (its address/prefix, IPv4 and IPv6) | On Lightsail there is no VPC CIDR to read; the instance's private network is refused instead (on EC2 it is inside the VPC anyway) |

**Policy, compared with §4.** §4 is default-deny because a community overlay
exit carries strangers' traffic at its operator's legal risk and publishes a
policy clients choose by. A consumer VPN that refused everything but a port
list would not be a VPN, so the standard tier is default-allow with the denies
above, the same trade every consumer VPN makes. The SSRF list is not relaxed.

**Rebinding.** §3's resolve-check-connect rule is for exits that resolve names
for the client. A WireGuard exit never resolves anything: it forwards packets to
the address the device already chose, and the filter checks that address on
every packet.

### 9.3 What it keeps

Nothing per connection. No `log` rule exists in the ruleset; the agent logs
counts and errors only, never a key or an address; the journal is kept in
memory only (`Storage=volatile`, 64 MB), so a disk snapshot holds no history.
The state that does exist: the kernel's connection-tracking table, which NAT
needs, in memory for the life of each flow — idle established TCP flows are
forgotten after an hour (`nf_conntrack_tcp_timeout_established=3600`, not the
kernel's five days), and a revoked peer's entries are deleted when it is
removed; WireGuard's in-kernel peer state
(each peer's current endpoint IP and last handshake), in memory, overwritten,
never read or exported by TNP; named aggregate nftables counters
(forwarded, refused by class, throttled); the resolver's cache of answers, in
memory, and its copy of the registry's TLD list on disk (§9.7) — no query log;
and the month's total uplink byte count, one number (§9.9). The API never
receives handshake times, endpoints or traffic figures.

### 9.4 The agent

`apps/exit/src/index.ts`, unprivileged (`User=tnp-exit`, `CAP_NET_ADMIN`
only). Every ~20 s: `GET /exit/peers` with its bearer token, parse with the
shared contract, read `wg show wg0 allowed-ips`, apply the difference with
`wg set` argument arrays (no shell), then delete the connection-tracking
entries of every removed peer (`conntrack -D`, argument arrays), so a revoked
device's flows end at once.

Failure is conservative only briefly. An unreachable API, a non-200, a
malformed body or unexpected `wg` output changes nothing for up to **10
minutes** (`TNP_EXIT_MAX_STALE_SECONDS`); after that the agent removes every
peer — fail closed — because a device revoked during the outage would otherwise
keep working for as long as it lasts. A **401/403** (this exit's token revoked)
or **503 `vpn_not_configured`** removes every peer at once. Peers come back on
the next successful sync. So the promise users are given is: a revoked device
stops working at the exits' next sync, normally within a minute, and within
about 10 minutes even if an exit is cut off from TNP.

The API also holds a freed tunnel address back for **24 h** before another
device can get it (`vpn_address_quarantine`: the address and when it was
freed, nothing else), so no new device inherits the old one's flows, here or
in remote servers' sessions keyed by the exit's address and port.

The agent also keeps the monthly traffic cap (§9.9).

`/health` on `127.0.0.1:9817` (`ok` / `starting` / `stale` / `flushed`). The unit
runs with `IPAddressDeny` for the metadata service (`169.254.169.254`,
`fd00:ec2::254`), `SystemCallFilter=@system-service`, and the usual systemd
sandboxing; check `/health` after the first boot of a new image, since the
syscall filter is enforced only on a real host.

### 9.5 Host bootstrap (for oxy-infra)

`apps/exit/deploy/bootstrap.sh`, run once as root — from user-data on EC2
(Amazon Linux 2023, or Debian 12 / Ubuntu 22.04 / 24.04 with the AWS CLI), or
over SSH on Lightsail (§9.8). arm64 or x86-64. Inputs, none secret:

| Variable | Default | |
|---|---|---|
| `TNP_EXIT_ID` | *required* | Matches the exit's `id` in `TNP_VPN_EXITS` |
| `TNP_EXIT_COMMIT` | *required* | Full SHA of the reviewed commit |
| `TNP_EXIT_SECRETS` | `ssm` | `ssm` (EC2, instance role) or `file` (Lightsail; §9.8) |
| `TNP_EXIT_SSM_PREFIX` | `/tnp/exit/<id>` | `ssm` only |
| `TNP_API_URL` | `https://api.tnp.network` | |
| `TNP_VPN_DNS` | *empty* | The API's network-wide resolvers; DNS forwarded to them is rate-limited per peer |
| `TNP_EXIT_DNS_UPSTREAM` | `https://1.1.1.1/dns-query,https://8.8.8.8/dns-query` | The exit resolver's upstreams; `https://` DoH URLs only (§9.7) |
| `TNP_EXIT_MONTHLY_CAP_GB` | `0` (no cap) | Monthly traffic cap, in + out, decimal GB (§9.9) |
| `TNP_EXIT_THROTTLE_MBIT` | `2` | Forwarding rate once the cap is reached |
| `TNP_EXIT_SSH_FROM` | *empty* (no SSH) | CIDR(s) allowed to reach SSH once the filter loads |

1. Installs `wireguard-tools`, `nftables`, conntrack tools, `git`, `unzip`
   (`dnf` or `apt`, by `/etc/os-release`; anything else is refused).
2. With `ssm`: **refuses to continue if IMDSv1 answers** (an unauthenticated
   metadata GET must fail), then reads region and VPC CIDRs from IMDSv2. With
   `file`, no metadata is required (Lightsail): a VPC CIDR is used if IMDS
   offers one, and IMDSv1 answering is a note, not a refusal — no instance
   role there holds anything of TNP's, and peers and services are blocked from
   the metadata address either way. The uplink and its own networks come
   from `ip`, on any host.
3. Keeps the journal in memory only.
4. Installs Bun at the repository's pinned version, verified against a pinned
   SHA-256.
5. Fetches **exactly** `TNP_EXIT_COMMIT` from the public repository, verifies
   `HEAD`, and installs the agent's and the resolver's production dependencies
   from the frozen lockfile. (Chosen over a release tarball because no exit
   release pipeline exists, and a pinned commit is content-addressed and
   reviewable.) With `file`, checks the on-disk secrets (§9.8) before going on.
6. Renders the ruleset, runs `nft -c` and loads it (replacing the
   distribution's default ruleset file, which on Debian flushes everything and
   accepts all). Forwarding is **not** enabled by `sysctl.d`: at boot it could
   come up before the filter.
7. Installs and starts `tnp-exit-wg.service`. At every boot it switches
   forwarding off, verifies the `tnp_exit` table is loaded (else refuses),
   reads the private key and agent token (at least 43 base64url characters)
   from SSM — or, with `file`, from the checked secrets directory — into
   `/run`, creates `wg0` with the key and deletes the `/run` copy, and only
   then switches forwarding on. Any failure, and stopping the unit, switch it
   off again. Then `tnp-exit-agent.service` (token handed over with
   `LoadCredential=`), then `tnp-exit-dns.service` (§9.7), which requires
   `tnp-exit-wg` and starts after it.

Example user-data:

```bash
#!/bin/bash
set -euo pipefail
export TNP_EXIT_ID=usw2-1
export TNP_EXIT_COMMIT=0123456789abcdef0123456789abcdef01234567   # the reviewed commit
export TNP_VPN_DNS=203.0.113.53                                      # same value as the API's
export TNP_EXIT_MONTHLY_CAP_GB=0                                     # EC2 bills per GB: cap with a budget instead, or set one
curl -fsSL "https://raw.githubusercontent.com/OxyHQ/tnp/$TNP_EXIT_COMMIT/apps/exit/deploy/bootstrap.sh" \
  -o /root/tnp-exit-bootstrap.sh
bash /root/tnp-exit-bootstrap.sh
```

Upgrade by replacing the instance with a new commit: the identity is the SSM
key, not the disk, so the exit's public key and endpoint do not change.

### 9.6 Infrastructure requirements

| Item | Requirement |
|---|---|
| Instance | arm64 (Graviton), AL2023. `t4g.small` to start; `c7gn.medium` or larger for many users |
| Address | An Elastic IP, and a DNS-only (not proxied) record for the endpoint — Cloudflare's proxy cannot carry WireGuard UDP. The EIP is also `endpointIp` in `TNP_VPN_EXITS`: routers dial it directly |
| Subnet | A public subnet whose route table has **no S3 gateway endpoint** (a dedicated subnet and route table, or a public one without the endpoint): with one, peers' traffic to S3 would bypass the exit's public address and reach S3 from inside the VPC |
| Security group | Inbound UDP 51820 from `0.0.0.0/0` and `::/0`; nothing else inbound (no SSH; use SSM Session Manager if shell access is wanted). Egress all |
| Source/dest check | Leave **on**: traffic is masqueraded, so the instance only ever sends from its own address |
| IAM | `ssm:GetParameter` on `parameter/tnp/exit/<id>/*` and `kms:Decrypt` on the key that encrypts them (condition `kms:ViaService` = SSM). Nothing else |
| SSM | `/tnp/exit/<id>/wg-private-key` (SecureString, `wg genkey` output) and `/tnp/exit/<id>/agent-token` (SecureString, at least 43 random base64url characters, e.g. `openssl rand -base64 48 \| tr '+/' '-_' \| tr -d '='`, one per exit) |
| API env | `TNP_VPN_EXITS` gains `{ id, region, endpoint: "<host>:51820", endpointIp: "<EIP>", publicKey, dns: "10.77.0.1" }` with the public key of the exit's private key and `dns` its own resolver (§9.7); `TNP_EXIT_TOKENS` gains that exit's token; `TNP_VPN_EXIT_ADDRESSES` gains the EIP, so VPN users browsing the dashboard through the exit are rate-limited per account rather than as one address; `TNP_VPN_ALLOWED_USERS` names the accounts that may use the VPN (in production, unset = off) |
| IMDS | IMDSv2 required, hop limit 1 (the bootstrap refuses an instance where IMDSv1 answers) |
| Logging | **No VPC Flow Logs, traffic mirroring or packet capture** on the exit's subnet or ENI: they would record every destination this document says is not kept |
| Public resolver | Only for exits whose `TNP_VPN_EXITS` entry has no `dns` (and for configs written before per-exit DNS): add each such exit's Elastic IP to the resolver's `TNP_DNS_RATE_LIMIT_EXEMPT` ([`dns-server.mdx`](../dns-server.mdx)). Without it, every peer of an exit shares one per-source budget there (`TNP_RATE_LIMIT_QPS`, default 20/s). Exempt sources still count toward the resolver's in-flight and TCP caps, and the exit's own per-peer limit (50 packets/s) bounds what any one device can send. The list is strict: an invalid entry stops the resolver from starting in production |
| Abuse | AWS abuse reports for exit traffic go to Oxy; they can be answered only from the aggregates above (§6) |
| Cost | An AWS Budgets alert in oxy-infra on the exit's spend (§9.9) |

### 9.7 The exit's own resolver (`tnp-exit-dns`)

**Why.** A device's DNS used to go to TNP's public resolver in us-west-2 for
every exit, so a user in Europe paid a transatlantic round trip per lookup, and
— worse — the resolver's DoH upstream answered from Oregon, so CDNs handed out
US edges. Each exit therefore answers its own peers' DNS, near the exit.

**What.** `apps/exit/deploy/tnp-exit-dns.service` runs TNP's resolver — the
same code as the public one (`apps/dns-server`, `DnsProxy`): TNP-native names
from the registry (`TNP_API_URL`), never forwarded; public names over DoH to
`TNP_EXIT_DNS_UPSTREAM` (default Cloudflare then Google, `https://` only); the
per-source response rate limit (20/s, burst 100) — and since every source is a
peer's tunnel address, that limit is per device, which the public resolver
behind one exit address cannot offer. No query is logged: the resolver logs
startup, upstream failures and counts, never a name.

**Where it listens.** `10.77.0.1:53`, UDP and TCP — `VPN_EXIT_TUNNEL_IPV4`, the
address `wg-up.sh` puts on `wg0` — and nowhere else. The packet filter admits
port 53 on input only from `wg0`, only from `10.77.0.0/16`, only to that
address, rate-limited per peer; nothing on the uplink reaches it.

**Recommended `dns` for every exit: `"10.77.0.1"`.** The gateway address is the
same on every exit, so the entry is identical everywhere and a config always
names the resolver on the exit it tunnels to:

```json
{ "id": "use1-1", "region": "us-east-1", "endpoint": "use1-1.exit.tnp.network:51820",
  "endpointIp": "<static IP>", "publicKey": "<exit public key>", "dns": "10.77.0.1" }
```

An exit without `dns` falls back to `TNP_VPN_DNS` (the public resolver).

**Sandbox.** Own user (`tnp-exit-dns`), `CAP_NET_BIND_SERVICE` only,
`ProtectSystem=strict` with a `StateDirectory` for the registry's TLD list,
`IPAddressDeny` for the metadata service, `SystemCallFilter=@system-service`.
`Requires=`/`After=tnp-exit-wg.service`: it binds an address that exists only
while `wg0` does, and stops or restarts with it.

**Its API traffic.** The resolver calls `GET /dns/resolve` for native names
only (public names never reach the API), from the exit's public address. That
address is in `TNP_VPN_EXIT_ADDRESSES`, so the API meters it against the exit's
shared anonymous tier: 20 addresses' worth, for the `resolve` class a burst of
6,000 and 1,000 requests a second. A native lookup costs at most 3–4 calls
uncached, and native names are a small share of anyone's lookups, so this is
orders of magnitude above what the resolver needs. It is **deliberately not
exempted**: the exit's address is shared with every peer's own traffic, so an
exemption would also give every VPN user an unmetered path to the API. The
residual risk — one peer deliberately spending the exit's shared `resolve`
tier, which would make `.ox` names (not public ones) SERVFAIL at that exit until
it refills — is accepted; if it is ever seen, the fix is a per-exit resolver
credential, not an exemption.

### 9.8 Lightsail exits (no instance role)

Lightsail is the fixed-price home for an exit (a bundle includes a monthly
transfer allowance; §9.9 keeps use inside it). It has no IAM instance role, so
the exit's secrets cannot come from SSM; the operator copies them in.

**`TNP_EXIT_SECRETS=file`.** `wg-up.sh` reads
`/etc/tnp-exit/secrets/wg-private-key` and `/etc/tnp-exit/secrets/agent-token`
(`apps/exit/deploy/secrets.sh`) and refuses to bring `wg0` up — so nothing is
forwarded — unless the directory is a real directory owned by root with mode
`0700` and each file a regular file (not a symlink, not hard-linked) owned by
root with mode `0600`. **Trade-off:** the files must survive a reboot, so,
unlike the SSM path, the private key is at rest on the instance's disk, readable
by root. Anyone with root on the instance, or a snapshot of its disk, has the
exit's identity. Mitigations: no snapshots of an exit's disk, SSH closed after
deployment (below), and rotation — generate a new key pair, update
`TNP_VPN_EXITS`, replace the instance — after any doubt.

**Operator flow** (us-east-1, exit id `use1-1`):

1. Create the instance: an OS blueprint (Debian 12 or Ubuntu 22.04/24.04), the
   bundle whose transfer allowance you will cap against, and attach a
   **static IP** (that is `endpointIp`). Add a DNS-only record for the endpoint.
2. Lightsail firewall (IPv4 and IPv6): **UDP 51820 from anywhere**; **TCP 22
   only from your own address, temporarily**; nothing else. Remove Lightsail's
   default HTTP rule.
3. Make the secrets on your own machine (`wg genkey > wg-private-key`,
   `wg pubkey < wg-private-key` for `publicKey`; the token as in §9.6) and copy
   them in without them touching the instance's home directory:

   ```bash
   ssh admin@<static-ip> 'sudo install -d -m 0700 -o root -g root /etc/tnp-exit/secrets'
   ssh admin@<static-ip> 'sudo sh -c "umask 077; cat > /etc/tnp-exit/secrets/wg-private-key"' < wg-private-key
   ssh admin@<static-ip> 'sudo sh -c "umask 077; cat > /etc/tnp-exit/secrets/agent-token"' < agent-token
   ```

   (`admin` on Debian, `ubuntu` on Ubuntu.) Keep the originals in the
   operator's secret store, not on a laptop.
4. Run the bootstrap (in `tmux` or `screen`: the packet filter loads mid-run;
   the established session survives, a dropped one cannot reconnect):

   ```bash
   C=0123456789abcdef0123456789abcdef01234567   # the reviewed commit
   curl -fsSL "https://raw.githubusercontent.com/OxyHQ/tnp/$C/apps/exit/deploy/bootstrap.sh" -o bootstrap.sh
   sudo TNP_EXIT_ID=use1-1 TNP_EXIT_COMMIT=$C TNP_EXIT_SECRETS=file \
     TNP_VPN_DNS=203.0.113.53 TNP_EXIT_MONTHLY_CAP_GB=3600 TNP_EXIT_THROTTLE_MBIT=2 \
     bash bootstrap.sh
   ```

5. Check `systemctl status tnp-exit-wg tnp-exit-agent tnp-exit-dns` and
   `curl -s 127.0.0.1:9817/health`, then **delete the TCP 22 rule** from the
   Lightsail firewall. Once the filter is loaded the host refuses SSH itself
   unless `TNP_EXIT_SSH_FROM` was set; upgrade by replacing the instance.
6. In the API: add the exit to `TNP_VPN_EXITS` (with `dns: "10.77.0.1"`), its
   token to `TNP_EXIT_TOKENS`, its static IP to `TNP_VPN_EXIT_ADDRESSES`.

The packet filter's metadata-address block (`169.254.0.0/16`, `fd00:ec2::254`)
applies on Lightsail exactly as on EC2.

### 9.9 Monthly traffic cap, and the budget alert

Lightsail counts transfer **in and out** against the bundle's allowance and
bills every GB beyond it; EC2 bills every GB out. An exit must not cost more
because more people use it, so the agent enforces a cap
(`apps/exit/src/traffic-cap.ts`):

- **Counts** every byte on the uplink, both directions
  (`/sys/class/net/<uplink>/statistics/{rx,tx}_bytes`), per calendar month in
  UTC, once a minute. One total, nothing per peer.
- **Persists** the total, the last counter readings and the kernel boot id in
  `/var/lib/tnp-exit/traffic.json` (the agent's `StateDirectory`, mode `0700`,
  writable only by the agent's unprivileged user). A restart resumes from the
  saved readings, so bytes moved while the agent was down are counted at the
  next reading; after a reboot (new boot id) the counters restart from zero and
  all they show is new. A new month starts again from zero.
- **Warns** in the journal at 80% of `TNP_EXIT_MONTHLY_CAP_GB`, once a month.
- **Throttles** at the cap: an nftables table of its own (`tnp_exit_cap`, so the
  packet filter is never touched) polices everything forwarded into and out of
  `wg0` to `TNP_EXIT_THROTTLE_MBIT` (default 2 Mbit/s) each way, for all peers
  together, until the month rolls over (UTC), when it is lifted. It is
  re-applied after a restart or reboot if the month's total is still over.

Set the cap below the allowance, leaving room for the counting interval and for
traffic that is not forwarding (the bootstrap, the agent, the resolver): for a
bundle with 4,096 GB, `TNP_EXIT_MONTHLY_CAP_GB=3600`. GB here are decimal (10⁹
bytes), as AWS bills.

**Budget alert (oxy-infra).** Independently of the cap, oxy-infra sets an AWS
Budgets alert on the exits' Lightsail spend: a monthly cost budget at the
bundle price (per exit), alerting the operator when actual or forecast spend
exceeds it — the signal that something outside the cap (a second instance, a
snapshot, an unexpected charge) is costing money.
