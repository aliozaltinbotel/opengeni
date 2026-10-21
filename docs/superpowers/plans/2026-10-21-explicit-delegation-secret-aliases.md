# Explicit delegation secret aliases implementation plan

**Goal:** Preserve the native Q-16 effective permission ceiling when existing organization keys delegate permissions, without rewriting keys or widening workspace scope.

**Architecture:** Both delegation doors use the existing explicit `hasPermission` predicate. Alias direction, literal `secrets:read`, authenticated provenance, selected workspace scope and developer setup restrictions remain their current owners. No schema, key migration, permission vocabulary or full-preset change.

**Spec:** `docs/architecture.md` section 3.6; Q-16 read-time alias contract in `packages/contracts/src/permissions.ts`; native access implementation in `packages/core/src/access/index.ts`. Cendra canonical lineage resolves to v1.9.5 with v1.8.2 foundations. Original upstream HEAD f67663ce6ff4c5fbb3427fb526d06dc98533e615 has no access/permission-file changes relative to dbb7493c893ca9000d256ddae85784c51a5aa6be; the defect remains. Candidate baseline is reviewed fork 204bef46716041960e49726ec7d9b68a31da6910.

- [x] Add failing regressions in existing core/API tests: legacy full policy lacks only canonical secrets:use but already grants its native alias; current full remains allowed; missing use aliases, literal secret-read or another full permission refuses; alias direction stays one-way; selected workspace remains bounded.
- [x] Correct both existing delegation doors using explicit effective permission checks; retain current error/refusal ordering and all other fences. Run focused core and API tests, relevant typechecks and formatting.
- [x] Independent read-only authority review, exact diff and negative-case evidence. Publish a coherent fork PR for a subsequent qualified repin; do not modify the installed runtime or keys from source-test success.

No bridge release or tenant-key rotation is justified for this alias-only incompatibility if the native contract tests prove existing effective authority is unchanged. Other native schema/activation requirements remain separate and are not waived.

## Verification (2026-10-21)

On Bun 1.4.0 with transpiler cache disabled, the unchanged baseline failed the new core cases (11 pass, 2 fail) and HTTP route case (14 pass, 1 fail). The corrected source passed core 13/13 and API 15/15. API persistence is mocked; this does not establish a deployed business outcome. Core TypeScript (`tsc --noEmit -p packages/core/tsconfig.json`) and changed-file oxlint with denied warnings exited 0. `git diff --check` passed. Independent read-only review of the four production substitutions and refusal cases found no blocking issue.

No installed runtime, schema or key changed. Existing legacy keys retain read-time alias compatibility. Newly minted canonical permissions can still be incompatible with the old runtime's vocabulary; the subsequent Cendra repin must qualify provisioning and forward recovery separately. Full native runtime deployment and real client journeys remain unverified.
