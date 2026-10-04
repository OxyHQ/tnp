# tnp frontend candidate preflight

Existing frontend sources typecheck against Oxy candidate 1b505 and published
Bloom 6.2.1. No frontend runtime source was changed. All listed importers resolve
the byte-verified package files in proof.json. Package manifests and locks here
are evidence snapshots; actual candidate file dependencies remain uncommitted.

Typechecks cover the listed importers.
Web Vite build and edge worker build passed. These are static/bundling checks, not browser
rendering or Android/iOS acceptance. Warnings are preserved in the full logs.
Existing product authentication/commerce behavior and UI components are unchanged.

Final Oxy registry install/lock, current SDK correction, application registration
and runtime smoke remain pending. This preflight is not a rollout or live-auth
claim. No frontend deployment was performed.
