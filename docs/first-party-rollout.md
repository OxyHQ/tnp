# Own Oxy platform access

TNP's API, DNS daemon and hosted relay use the shared Oxy workload lane with a
live application/environment binding. Temporary AWS role credentials work on ECS
and authenticated development/SSO hosts. There is no customer API-key fallback,
application scope requirement or inter-app consent for these own processes.

The dashboard retains its shared linked session client. Domain ownership, signed
network grant chains, purpose/name narrowing, relay certificates and revocation
remain protocol authority; they are not OAuth scopes. External registrar keys
(such as Namecheap) remain provider credentials.

Infrastructure activity requires a configured region. Without one, local boot
omits only the publisher; authentication remains available. A configured publisher
uses the shared retry/backoff and reports missing/revoked workload authority.

Release gate: this source was validated with Oxy core 7, contracts 6, protocol
1.5.1 and services 13 candidates. Pin the published registry versions before
merging/deploying; no local tarball override is committed. The receiver HTTP
fixture explicitly disposes its shared Oxy client so its background resources do
not outlive the child process.
