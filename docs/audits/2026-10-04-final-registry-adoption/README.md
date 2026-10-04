# tnp: published SDK adoption

Source `4a7b5437f1869b77f5ed652a50a0b07871c4b8be` pins the published SDK and its measured compatible Bloom version, including the regenerated lockfile. Existing application behavior and previously reviewed fixes remain in the branch.

Validation: {"receiverPassed": 1, "sdkImporterMembers": 4742, "bloomImporterMembers": 20940, "typesBuildExport": "passed"}. Exact commands, logs, archive member hashes and importer resolutions are in [proof.json](proof.json).

- Published registry archives and all installed SDK importer members were compared byte for byte. Stale same-version candidate materializations were retained and repaired with a frozen install; their setup failures remain in the records.
- Local web export proves compilation, not browser/native acceptance or deployed public-client configuration. Required PR/main CI and root image/promotion remain separate.
- No production database, provider writes, grants, credentials or auth fixtures were changed. Receiver uses a loopback-only synthetic issuer in an isolated child.
- Filtered receiver tests are not full-suite acceptance. Syra notifications retain their pre-existing scope denial; no permission expansion. TNP DNS/relay checks do not claim an API image was deployed.
