# TNP API candidate compatibility

Based on current main 8ee271e, including the live source 954ea61 and PAY04 docs.
Current source already uses OxyServer/createOptionalOxyAuth; no product middleware
or commerce code was replaced. The new probe runs in a separate process with a
minimal environment and empty owned working directory, so even config's explicit
dotenv.config() cannot read another checkout's credentials. Fetch rejects
non-loopback destinations. The process imports the actual optional middleware and
pairs it with the same requireOxyAuth used by protected domain routes.

One test covers three controls over real HTTP and installed candidate SDK:
missing/sessionless bearer denial, live owner vs contradictory subject, and
revocation on the next call. Issuer signature/authority is synthetic; no domain
SQL, real credentials, DNS mutation, provider or commerce effect is exercised.

API types and all 193 API tests pass; whole-workspace typecheck/tests also pass.
Web types and Vite/edge build pass with no runtime source change. Initial fixture
implicit-any type failure is retained; types-final is successful. Existing test
mocks and commerce controls remain unchanged. Logs preserve build warnings.

Four targets remain explicit: final Oxy registry versions/lock, latest SDK fix,
CI and coordinated runtime rollout. Candidate file manifests are local evidence
snapshots, not committed release dependencies. Frontend package byte checks and
static boundaries are documented in ../2026-10-03-final-sdk-frontend/proof.json.
