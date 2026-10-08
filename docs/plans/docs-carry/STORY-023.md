<!-- Carry to the docs repo: stories/api/STORY-023-zod-openapi-client-pipeline.md, AC5 (line 25) and Test scenario 4 (line 45). Nominara-Dev-Docs-main has no .git. -->

- [ ] **NOT MET — no CI exists in this repository (`.github/` is absent), and this needs a registry and OIDC trust that live in `nominara-infra` (KAD-10), which is not cloned here.** The semver DERIVATION itself is built and tested (`deriveSemverBump`); what is missing is the pipeline that runs it on merge. **Merging publishes the client at a semver derived from the specification diff**: **minor for an added optional field (at any depth, owner decision R5, 2026-10-08) and for new endpoints, major for any removal or type narrowing**.

| 4 | Add an optional field | Minor-level publish (owner decision R5, 2026-10-08: any depth) |
