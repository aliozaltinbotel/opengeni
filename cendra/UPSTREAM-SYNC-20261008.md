# Upstream sync 2026-10-08 (MAINT-P09-433)

Branch `cendra/upstream-sync-20261008-89e3a2ad` of `aliozaltinbotel/opengeni`. It starts at the production pin
`6c2c7eaf17dfeb485d8b89d89d7a85d061ed5f1d` (fork branch `cendra/native-procedures-source-6c2c7eaf`) and merges
upstream `Cloudgeni-ai/opengeni` `main` with `--no-ff`. No fork commit was rebased or rewritten. Fork `main` and
`production` were not touched.

| Item | Value |
| --- | --- |
| Upstream SHA merged | `89e3a2ad95e0fca58e1e1483cadcb1c6bc3661ce` ("fix(native): the inbox says when it couldn't load (#3857)") |
| Upstream commit time | 2026-10-08T15:18:06Z; fetched 2026-10-08T15:50:04Z |
| Merge base | `665e8495dee2f43f8e3dc0fe903131dfecf7dd75` (2026-09-30) |
| Fork side / upstream side | 58 commits / 800 commits |
| Merge commit | `f3d4a15d5e01006965f8839e939d13fd2d956819` (parents: pin, upstream) |
| Follow-up commits | `f933c6bb8` migration renumbering; this report |
| Upstream head at report time | `42a50cd1f1b5ac1a231d42fb7a9291633970716f` (3 commits later, adds `0656_inbox_owner_recipient`); not merged |

History. The shared fork clone is shallow at `662b922f3` (2026-07-02), far below the merge base. All 800 upstream
commits since the merge base were fetched without depth limits and with no missing objects, so the merge base is exact.

## Conflicts and resolutions (39 files)

Resolution rule: upstream's structure is the base; every fork intent is re-applied on top of it. Generated files take
upstream's bytes and must be regenerated.

| File | Resolution |
| --- | --- |
| `AGENTS.md` | Upstream's rewritten lines; the fork's realtime-delegation route sentence re-attached. |
| `apps/api/src/routes/sessions.ts` | `createSessionForRequestWithOutcome` + `freshCreated` (ea564b0a7) inside upstream's measured `core_create`/`response_projection` phases; upstream's `keepLive` mark now updates `result.session`; `delegationExecutionPolicies` kept in the realtime ledger call. |
| `apps/api/test/{external-membership-operations,private-session-denial,session-authorization,session-realtime-routes}.test.ts` | Unions of imports and route tables. |
| `apps/worker/src/activities-turn.ts` | Union: upstream drain/finalization deps + fork `authorizeModelCallSource`. |
| `apps/worker/src/activities/agent-turn/claim.ts` | Union of imports. |
| `apps/worker/src/activities/agent-turn/compaction-prep.ts` | Fork source-key tracking inside upstream's new `summarizeModel`; upstream's credit gate wrapper kept; the key also resets at the outer entry so a refused gate never reports a stale key. |
| `apps/worker/src/activities/agent-turn/errors.ts` | Union: upstream `providerHttpStatus`/`isTransportTimeoutError` + fork PQA-0044 classifier (same seam). |
| `apps/worker/src/activities/agent-turn/failure-settlement.ts` | Upstream `withModelRoutePresentation` closing; fork F-2/NPD-013 named endings and host recovery refusal after it. |
| `apps/worker/src/activities/agent-turn/governance-model.ts` | Fork isolated-assessment gating kept; upstream's new workspace agent identity is null for an isolated assessment (adapted). |
| `apps/worker/src/activities/agent-turn/run.ts` | Union of imports. |
| `apps/worker/src/activities/agent-turn/stream-attempt.ts` | Upstream admission-failure handling + fork tool-path timer; fork source keys on title usage and terminal events kept with upstream `creditPolicyRevision`; upstream removed the per-response `ensureRunAllowed`, so the fork's `ensure_run_allowed` phase now times upstream's per-model-call admission (adapted). |
| `apps/worker/src/activities/run-input.ts` | Fork `[Session image]` receipt + upstream comment. |
| `apps/worker/test/context-compaction-activity.test.ts` | Union of imports. |
| `docs/architecture.md` | Upstream's reworded lines + the fork's source-receipt/Skill paragraphs (500-char line limit holds). |
| `packages/contracts/src/index.ts` | Unions (imports, `initialMessageModelSourceRefs` beside `keepLive`, re-exports). |
| `packages/core/src/domain/sessions.ts` | Fork source refs added to upstream's measured create/replay calls; the moved `validateFileResources` call carries `payload.requestedSessionId`; fork `turnRouteDeclaration` after upstream's credential-restricted policy. |
| `packages/db/src/index.ts` | Union of the export blocks; upstream's richer recovery metadata moved into the fork's `recoveryMetadata` constant used by the declared-fallback path. |
| `packages/db/src/runtime-posture.ts`, `session-queue-commands.ts`, `session-realtime-ledger.ts` | Unions (owner-internal routines; archive refusals before fork ref parsing; fork route resolution beside upstream's frozen connector snapshot). |
| `packages/db/test/{session-realtime-ledger,skill-catalog-context}.test.ts`, `packages/documents/test/knowledge-preparation-postgres.test.ts` | Both sides' tests kept; upstream's legacy billing assertion added inside the fork's parameterized test. |
| `packages/runtime/src/index.ts` | Unions; E-14 final-refusal wording ahead of upstream's outcome-unknown text, after upstream's routing rethrow and interaction errors. |
| `packages/runtime/src/lazy-tool-transport.ts`, `model-request-capture.ts` | Fork structure kept: `ModelRequestCaptureModel` is the single capture owner on both paths; upstream's per-call `beforeModelRequest` admission and response settlement run there once (the lazy path is `ModelRequestCaptureModel(LazyToolModel(model))`, so no double admission). |
| `packages/runtime/src/model-provider-client.ts` | Union of imports; source dispatch authorization still precedes transport. |
| `packages/runtime/src/provider-history-adapter.ts` | Fork developer-message binding + upstream projections; upstream's new foreign-reasoning projection now keeps the row's source binding (adapted). |
| `packages/runtime/test/model-request-capture.test.ts`, `packages/sdk/test/codex-realtime-controller.test.ts` | Both sides' tests. |
| `packages/sdk/src/{client,index,codex-realtime-controller}.ts` | Unions; realtime start keeps upstream `connectedInMode=false` and the fork's retained owner. |
| `packages/sdk/src/site-browser-runtime.gen.ts` | Upstream bytes; regeneration pending. |
| `scripts/public-api/surface.gen.json` | Hand union in the file's case-insensitive order; regeneration pending. |
| `scripts/release-schema-contract.test.ts` | Upstream's derived `latestMigration`/`fileCount`; the fork migrations stay in the forward (appended) lists under their new names. |

## Retained delta (FORK_DELTA_OF_PRODUCTION, 58 entries)

Method: for each of the 55 non-merge fork commits, every non-trivial line it added that is still present at the pin
was checked in the merged tree: 44 lose none, and every line the other 11 lose belongs to a deliberate resolution
listed below. For the 3 merge commits (42e636fe1, 4c8a22938, 6c2c7eaf1), the lines each merge introduced that are in
neither parent and still at the pin (198, 29 and 0) are all present. A converse check found no line the fork deleted
that the merge resurrected. Key symbols keep equal or higher counts
(for example `TURN_FALLBACK_NOT_RUN_REASONS`, `deferModelSchemasForEagerMcpServerIds`, `authorizeModelCallSource`,
`readModelCallSourceReceipt`, `delegationExecutionPolicies`, `isolatedAssessment`, `ToolPathPhaseTimer`), and the
F-2/NPD-013 contract segments (`TurnRouteDeclarationV1`, `TURN_ROUTE_TERMINAL_REASONS`, `TURN_HOST_TERMINAL_REASONS`,
`TURN_FALLBACK_NOT_RUN_REASONS`, `TurnBudgetV1`) are byte-identical to the pin.

| Commit | Verdict |
| --- | --- |
| d9b96c85e approval policy / sanitised MCP names, session-MCP host identity | Survives. Upstream 178b5ae0f adds exact prepared-server identities and managed tool decisions; the fork's sanitised-prefix fallback (cendra-pms) and `sessionMcpApprovalConnectionId` remain in policy construction and registration. |
| 2d950ecaf B3 approved resume by sanitised name | Survives. |
| 5b018bfc1 startApi SessionAuthorizationPort | Survives; `StartApiOptions` keys unchanged (`settings`, `observability`, `sessionAuthorization`). |
| d014adbfd test | Survives. |
| 0352becc7 realtime delegation route | Adapted: route resolution beside upstream's frozen connector snapshot; the API still resolves routes first. |
| 15d6d4432 agents-core patch | Survives (agents-core is still 0.14.3 upstream; patch file merged cleanly). |
| 42c60c365 deferModelSchemasForEagerMcpServerIds | Survives at the same seam. See coordinator check 2. |
| b24faac92 tool-path timing | Adapted: `ensure_run_allowed` times upstream's per-model-call admission. |
| 32a430695, f2f9bfac3 | Survive. |
| 5cb0d9aa1 external-member reconcile, guarded contexts | Survives. See coordinator check 4. |
| d1c387444 realtime begin intent | Survives. |
| 0f796816f E-14 | Survives. Upstream's interaction-control errors (OpenGeni API errors only) are handled before it. |
| d3ffce6da F-2 route and budget | Survives; the fallback recovery metadata now also carries upstream's recovery facts. |
| b3e80df88, 09deeac08, b4c66b449, 087b8b39a | Survive (contract lists byte-identical; PQA-0044 at the same seam). |
| 42e636fe1 previous sync merge | Merge commit; its 198 merge-own lines are all present. |
| f95ae3e6e legacy member permission updates | Adapted: migration 0550 is now 0656 with an idempotent body; TS lifecycle unchanged. |
| 3f5282b58, 5ce76cb51, ad3819509, 474ee6c00 | Survive. |
| c5bea8a03 native exact call source receipts | Adapted: migration 0551 is now 0657 with an idempotent body; API, SDK and worker code survive. |
| 2ad2e9fc3, 8fed749f8, 771d33945, 4cea606f1, 8bfa9bd31, bd8b57045 | Survive. |
| ea564b0a7 committed fresh creation outcome | Adapted into upstream's measured create path. |
| ef0b846cb, 5ab92a842, 2e96edbfb | Survive. |
| 6e4df75e8, 1762706f9 skill catalog freeze | Survive; upstream's Skill work since the base is in the instruction module (0bbe2e7cf), not the frozen catalog seam. |
| c376f0d13, 8d057d7c4, 054e20eb4 | Survive. |
| 4c8a22938 scoped Skills provenance (merge commit) | Survives; its 29 merge-own lines are all present. |
| 3a2f0ca4b provider/durable projections | Adapted: the binding also follows upstream's foreign-reasoning projection. |
| d842915e2 | Survives. |
| 93225455f lazy transports admission | Adapted: single capture owner now also runs upstream's model-call admission. |
| f1a505ada, ece2a9dc3, 1157b9dd0, 527857c15, f293b7364, a311d780d | Survive. |
| d65ae8c80 isolated image assembly | Adapted: no workspace agent identity in an isolated assessment. |
| 4d8551444 assessor image scope | Survives (temporary image session id passed in upstream's moved validation). |
| dfba3c0db, bba6b9fb1, 819c4635b | Survive. |
| 0f1efe4a8 recurring cleanup fairness | Adapted: migration 0552 is now 0658 with an idempotent body. |
| e03bcea26 release registration | Superseded by upstream's derived contract; names updated in the forward lists. |
| 6c2c7eaf1 evidence assessor merge | Merge commit with no own lines; covered by its constituents. |

Nothing was dropped.

## Coordinator checks

1. 178b5ae0f (unified tool permissions, durable action reviews) vs d9b96c85e/2d950ecaf: retained as above. The
   approval-gated session-MCP invoke refusal without a `connectorActionPolicy` exists at the pin too. 0618 only widens a
   provenance constraint. Repin check: Cendra's carrier approval mode for cendra-pms tools under the managed decision
   path (`preparation.managed`).
2. 41c86ae7a / 527933873 vs `deferModelSchemasForEagerMcpServerIds`: the option is still consumed in
   `installLazyToolRuntime`. The first model request no longer awaits lazy preparation unless stored work must resume;
   every function call still joins the shared preparation promise, and cendra-pms schemas stay behind tool search.
   First-turn behaviour on staging is a repin observation.
3. 334c470b0 idle-session archive: off by default (`sessionArchiveEnabled` default false in `packages/config`,
   `sessionArchive.enabled: false` in Helm values).
4. First-use auto-membership (cbe4357c7, `ensureExternalWorkspaceMemberOnFirstUse`): grants defaults through the same
   `prepare` lifecycle 0656 patches and never narrows, so the fork's legacy narrowing path is untouched. Risk: if
   Cendra's organization key holds `members:manage` plus the default conversation permissions, an `asUser` request can
   create a membership before Cendra's reconcile chooses permissions. The repin must check the key's permissions.
5. Stopped-fleet migrations since the base (maintenance mode with the live application-role check): 0585, 0597,
   **0598**, 0600, 0603, 0608, 0619, 0621 (eight; 0598 was missing from the coordinator list). Maintenance mode
   without that check: 0586, 0645. Rolling migrations that read the application-role list: 0588, 0589, 0590, 0604,
   0632. 0598 converts Claude credentials and needs `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` wherever Anthropic
   `api_key` connection rows exist (an empty database needs none).
6. Ordinals: renumbered after the merged SHA's last migration (0655). `bun scripts/check-migration-ordinals.ts --base
   89e3a2ad9...` passes (657 migrations, next 0659). Against upstream head `42a50cd1f` it fails: 0656 collides with
   `0656_inbox_owner_recipient`. The next sync renumbers again; the idempotent bodies make that safe.

## Migrations

Upstream assigned 0550 and 0552 to other files (`0550_organization_oauth_pending_states`, `0552_usage_allowances`)
and leaves 0551 unused. The ledger (`packages/db/src/migrate.ts`) is keyed by file name and applies every unrecorded
file in name order, so names never collided as keys; ordinals collided, and on a fresh database the fork files ran
before upstream's later changes to the same tables.

| Old (pin) | New | Body |
| --- | --- | --- |
| 0550_external_workspace_member_empty_permission_updates | 0656 | Accepts exactly the pre-image (`md5(prosrc)` `0b629b03...`, anchor once: rebuild) or the post-image (`b7505fb5...`, replacement once, no anchor: no-op). After a rebuild, `pg_proc` metadata (owner, ACL, SECURITY DEFINER, config) must be unchanged and the post-image md5 exact. |
| 0551_model_call_source_receipts | 0657 | Every object guarded (column, table, policy, triggers, FK); exact column shapes asserted; `fork_session_content` rebuilt only when all five anchors are present once, a no-op when all five replacements are present once and no anchor, refused otherwise. |
| 0552_recurring_temporary_image_cleanup_fairness | 0658 | Pre-image md5 pin `f9c5c9a6...` kept; exact post-image `59b622ef...` accepted as applied. |

All three set `lock_timeout`. No ledger alias was added: the 283 "fix0550" was itself a forward migration and
`migrate.ts` has no alias mechanism. Re-running converges a database whose earlier fork run preceded upstream's later
migrations, which an alias would not.

0547: `0547_idle_command_containment` landed upstream on 2026-10-02 (#3005, 4a63d4f51), after the 2026-09-30 merge
base. The pin lacks it by sync timing, not by choice; it is present now. On a database upgraded from the pin it runs
after 0548/0549 and the fork's old 0550-0552; it touches none of their objects.

Physical difference: on an upgraded database the fork columns `session_history_items.source_basis` and
`model_call_facts.source_receipt_id` precede upstream's later columns; on a fresh database they follow them. Column
order is not semantic, but a schema dump comparison must normalize it.

### Proof (real PostgreSQL 17.11, own container, data on tmpfs, removed afterwards)

Pin `6c2c7eaf1` migrator (read-only use of an existing pin install) as a NOSUPERUSER/NOBYPASSRLS owner, then the three
new files applied as that owner:

| Step | Result |
| --- | --- |
| Pin migrator | rc 0, 559 ledger rows incl. the three old fork names; NOTICEs only |
| `md5(prosrc)` on the pin database | `b7505fb5...` and `59b622ef...`, equal to the pinned post-images |
| T1: 0656/0657/0658 on the pin database | rc 0 each; schema dump byte-identical to the pin's |
| T2: rerun | rc 0 each; dump identical |
| T3: template copy with every fork object reversed, then the three files | pre-images `0b629b03...`/`f9c5c9a6...` confirmed after reversal; rc 0 each; dump identical to the pin's; rerun rc 0 |
| T4: wrong md5 pins (0658), wrong post-image pin (0656), partially rebuilt copy owner (0657) | Each refused: `TEMPORARY_IMAGE_CLEANUP_PREIMAGE_DRIFT`, `external workspace permission-update source contract changed`, `SOURCE_COPY_SPOOL_ANCHOR_DRIFT` |

Not proven (needs this branch's install, see Tests): (a) the head migrator on an empty PostgreSQL 17; (b) the head
migrator on a pin-migrated database, which also runs 0547, upstream 0550/0552-0655 and the stopped-fleet migrations;
and a normalized schema comparison of (a) against (b).

## Tests

Disk on the shared host was 7.0-8.4 GB free throughout, below the 10 GB floor the task sets, and a dependency install
needs about 2 GB more. Install-dependent gates were therefore **not run**. Nothing below is claimed green.

| Gate | Result |
| --- | --- |
| `bun scripts/check-migration-ordinals.ts --base 89e3a2ad9...` | PASS (rc 0) |
| same, `--base 42a50cd1f...` | FAIL (rc 1), expected: next-sync collision on 0656 |
| `bun scripts/check-docs-refs.ts` | PASS (rc 0) |
| Upgraded-path ledger proof | PASS (above) |
| `bun install` (Bun 1.3.14), `bun.lock` regeneration | NOT RUN. `bun.lock` is upstream's bytes; the fork changed no manifest or lock entry. |
| `bun run typecheck` | NOT RUN. The branch head is not compile-verified. |
| Tests api, core, db, runtime, worker, sdk, contracts; upstream baseline on a clean `89e3a2ad9` checkout | NOT RUN |
| `check:migration-schema-contract`, release-schema-contract test, public surface and site-browser generators | NOT RUN |

Follow-on, in order, with `BUN_INSTALL_CACHE_DIR` set to a fresh directory (the default cache is a dangling symlink):
`bun install`; regenerate `packages/sdk/src/site-browser-runtime.gen.ts` and `scripts/public-api/surface.gen.json`
(the bundle lacks the fork's SDK additions such as `getSessionModelSourceBasis` until then); `bun run typecheck`;
the package tests with the same commands on a clean upstream checkout to name inherited reds; the head migrator on an
empty PG17 and on a pin-migrated database, with a normalized dump comparison.

Most likely compile fixes: `apps/api/src/routes/sessions.ts` (the `result`/`retention` reassignment),
`compaction-prep.ts` (assigning `successfulModelSourceKey` on the wrapped summarizer), `failure-settlement.ts` (the
widened `failure` type), and `provider-history-adapter.ts` (the projection's return type). Likely fork-specific red to
classify: upstream's new `knowledge-preparation-postgres` test indexes without an RLS actor context, which 5cb0d9aa1's
guarded indexing context may refuse.

## Adapter-facing differences for the repin (MAINT-P09-434)

- Versions: every `@opengeni/*` package moves to the fixed release train 1.4.4 (for example contracts 5.4.0, core
  5.0.0, db 6.2.0, runtime 4.3.0, sdk 7.4.0, config 3.1.1, api-router 5.2.0, worker-bundle 2.2.0 all become 1.4.4). The
  numbers decrease, so any Cendra check that compares versions must not read it as a downgrade.
- All 85 named `@opengeni/*` imports in `packages/cendra-opengeni-runtime-adapter/src/*.ts` (Cendra origin/master)
  resolve in the merged tree (grep-level; the compile check is the repin's).
- Unchanged: `startApi(options)` (`StartApiOptions` keys), `runOpenGeniWorker(options)` (`RunOpenGeniWorkerOptions` =
  service options + `shutdownSignals`), `createApp(deps)` / `createAppComposition(deps)` signatures,
  `OPENGENI_API_CONTRACT_REVISION` `2026-09-plugins-and-skills-v1` (equal to Cendra's).
- Changed declarations the adapter uses (16): `hasPermission` gains a third `permissionMode` parameter and
  `AccessGrant.permissionMode` (`legacy`/`explicit`) is new; `requirePermission` honours explicit mode; `Permission`
  adds `usage_allowances:manage`; `requireLimit` answers 402 for `allowance_exhausted`; `AttemptToolCatalog` adds
  `firstPartyMcpPermissions`; `getAttemptToolCatalog`/`persistAttemptToolCatalog` round-trip through session content
  blobs (0648); `createDb` caps reconnect backoff; `findActiveApiKeyByHash` locks and reads workspace scopes;
  `lookupExternalIdentity` requires a live service key; `requireSessionAuthorization` shares claimed reads;
  `addDocumentToBase` records billing attribution; `AcceptSessionUserMessageDependencies` adds `observability`;
  `createAppComposition` constructs managed auth and storage differently inside; `ApiRouteDeps.syncScheduledTask`
  input gains optional fields and new optional deps (`entitlements`, `userPresence`, `directModelFetch`,
  `mcpCapabilityProbe`); the `SessionAuthorizationPort` comment only.
- Session create/send: `CreateSessionRequest` adds optional `keepLive`; approval-decision client events add optional
  `mcpCredentialUpdates`; the user message, steer and fork source-ref fields are unchanged.
- Branding: upstream renamed "OpenGeni" to "Opengeni" in messages (2 to 245 string occurrences in source). Cendra tests
  that match exact refusal text will need updating.
- Database: the stopped-fleet migrations above require a drained fleet; 0598 needs the encryption key where Claude API
  key connections exist; the renumbered fork migrations re-run as verified no-ops on staging.

## Open risks

- The branch is not compile- or test-verified (disk). Treat it as a source candidate until the follow-on gates run.
- Generated files and the lockfile are upstream's bytes; the surface file is a hand union.
- MAINT-P09-430's local commit adds `0553_usage_event_call_attributes.sql`, which collides with upstream's 0553; it must
  land at 0659 or later on top of this branch.
- Upstream's main already uses 0656; the next sync renumbers the fork migrations again.
- Repin observations: carrier approval mode under managed tool decisions, first-turn tool search for cendra-pms,
  first-use auto-membership versus Cendra's reconcile.
