# Upstream sync 2026-10-08 (MAINT-P09-433)

Branch `cendra/upstream-sync-20261008-89e3a2ad` of `aliozaltinbotel/opengeni`. It starts at the production pin
`6c2c7eaf17dfeb485d8b89d89d7a85d061ed5f1d` (fork branch `cendra/native-procedures-source-6c2c7eaf`) and merges
upstream `Cloudgeni-ai/opengeni` `main` with `--no-ff`. No fork commit was rebased or rewritten. Fork `main` and
`production` were not touched.

| Item | Value |
| --- | --- |
| Upstream SHA merged (round 2, current) | `e1395d4f0ca48debe5c54d042262529cf7b9732b` ("feat(native): open images full screen in the app, and take a photo from the composer (#3887)"), committed 2026-10-08T20:43:23Z, fetched 2026-10-08T20:49:52Z; merge commit `49b70335e` (parents `fe750ae24`, `e1395d4f0`) |
| Upstream SHA merged (round 1) | `89e3a2ad95e0fca58e1e1483cadcb1c6bc3661ce` ("fix(native): the inbox says when it couldn't load (#3857)"), committed 2026-10-08T15:18:06Z, fetched 2026-10-08T15:50:04Z; 25 commits before `e1395d4f0` |
| Merge base | `665e8495dee2f43f8e3dc0fe903131dfecf7dd75` (2026-09-30) |
| Fork side / upstream side | 58 commits / 800 commits |
| Merge commit (round 1) | `f3d4a15d5e01006965f8839e939d13fd2d956819` (parents: pin, upstream `89e3a2ad9`) |
| Round 1 follow-ups | `f933c6bb8` migrations to 0656-0658; `708b36be5` regenerated surface and Site runtime; `fb10c5dc1` test fits; `d8ad352d1` SDK fix; `8f9627e77` runtime error-text order and test fits; report |
| Round 2 follow-ups | `4e1948b65` migrations to 0665-0667; `b0c49cf11` gzip error-body fix (finding 1); `72d7e4d12` organization MCP exemptions (finding 2); `ec39c5657`, `5ba8c1eab` compaction source fixes; `a3da958f0` first-use membership opt-in (review P1-a); `37c6a85b3` test opt-ins; report |
| Round 3 (repin blockers) | `5567862ca254da34712f52d9c32ca1dc05e20aef` = **H**: two upstream type annotations; artifact runtime built for H (below) |

Fork `main` (`11febf6a7db69f479fecd162ae82b5fda3c58088`) and `production` (`e6453c8271ac6e198bbd1970a23f222e5613affc`)
are untouched. Both merges are anchored by SHA. Round 1 was reviewed at `fe750ae24` (MERGE_WITH_FIXES); round 2
adds the newer upstream and the review fixes on top, with no history rewritten.

History. The shared fork clone is shallow at `662b922f3` (2026-07-02), far below the merge base. All 800 upstream
commits since the merge base were fetched without depth limits and with no missing objects, so the merge base is exact.

## Conflicts and resolutions (39 files)

Resolution rule: upstream's structure is the base; every fork intent is re-applied on top of it. Generated files take
upstream's bytes and were then regenerated (`708b36be5`).

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
| `packages/sdk/src/site-browser-runtime.gen.ts` | Upstream bytes at merge time; rebuilt from the merged SDK in `708b36be5`. |
| `scripts/public-api/surface.gen.json` | Hand union at merge time; replaced by the regenerated surface in `708b36be5`. |
| `scripts/release-schema-contract.test.ts` | Upstream's derived `latestMigration`/`fileCount`; the fork migrations stay in the forward (appended) lists under their new names. |

### Round 2 conflicts (merge of `e1395d4f0`, 4 files)

| File | Resolution |
| --- | --- |
| `apps/worker/src/activities/context-compaction.ts` | Unions of imports and summarizer fields; upstream's byte-budget deferred items join the trailing items, every persisted item still loses its native binding. Two follow-ups: `ec39c5657` records the retained summary sources on upstream's new byte-budget path (the merge did not typecheck without it, TS2741), and `5ba8c1eab` keeps `trailingSourceIds` index-aligned with the deferred items. |
| `packages/runtime/src/index.ts` | Upstream's `anthropicCompactionRequest` runs inside the fork's exact-call source dispatch wrapper; upstream's synchronous-command and routing-mutation uncertain outcomes join the uncertain branch ahead of E-14. |
| `scripts/public-api/surface.gen.json`, `scripts/release-schema-contract.test.ts` | Unions; the surface regenerated identical, the action catalog was regenerated (`72d7e4d12`). |

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
| 15d6d4432 agents-core patch | Survives (agents-core is still 0.14.3 upstream). Upstream's new `agent-config-enforcement` test expected the open root; its expectation now states the fork's closed root. |
| 42c60c365 deferModelSchemasForEagerMcpServerIds | Survives at the same seam. See coordinator check 2. |
| b24faac92 tool-path timing | Adapted: `ensure_run_allowed` times upstream's per-model-call admission. |
| 32a430695, f2f9bfac3 | Survive. |
| 5cb0d9aa1 external-member reconcile, guarded contexts | Survives; upstream's first-use auto-membership is now a deployment opt-in, off by default (`a3da958f0`). See coordinator check 4. |
| d1c387444 realtime begin intent | Adapted (`d8ad352d1`): upstream's new end-on-refusal path called `stop()`, whose pending-begin reconciliation re-issued the begin; a reload reconciling a retained pending begin now stays terminal as at the pin. |
| 0f796816f E-14 | Adapted (`8f9627e77`, round 2 extended): upstream's uncertain-outcome texts first (integration, synchronous command, routing mutation), then E-14's final text, then invalid arguments, then the generic retry text. None of the first three says "Please try again". Ordering note only (review P2). |
| d3ffce6da F-2 route and budget | Survives; the fallback recovery metadata now also carries upstream's recovery facts. |
| b3e80df88, 09deeac08, b4c66b449, 087b8b39a | Survive (contract lists byte-identical; PQA-0044 at the same seam). |
| 42e636fe1 previous sync merge | Merge commit; its 198 merge-own lines are all present. |
| f95ae3e6e legacy member permission updates | Adapted: migration 0550 is now 0665 with an idempotent body; TS lifecycle unchanged. |
| 3f5282b58, 5ce76cb51, ad3819509, 474ee6c00 | Survive. |
| c5bea8a03 native exact call source receipts | Adapted: migration 0551 is now 0666 with an idempotent body; summary and trailing source ids follow upstream's byte-budget compaction (`ec39c5657`, `5ba8c1eab`); API, SDK and worker code survive. |
| 2ad2e9fc3, 8fed749f8, 771d33945, 4cea606f1, 8bfa9bd31, bd8b57045 | Survive. |
| ea564b0a7 committed fresh creation outcome | Adapted into upstream's measured create path. |
| ef0b846cb, 5ab92a842, 2e96edbfb | Survive. |
| 6e4df75e8, 1762706f9 skill catalog freeze | Survive; upstream's Skill work since the base is in the instruction module (0bbe2e7cf), not the frozen catalog seam. |
| c376f0d13, 8d057d7c4, 054e20eb4 | Survive. c376f0d13 puts `modelContext` on the execution turn, which upstream tests forbid on a claimed turn; those cases were already red at the pin (see Tests). |
| 4c8a22938 scoped Skills provenance (merge commit) | Survives; its 29 merge-own lines are all present. |
| 3a2f0ca4b provider/durable projections | Adapted: the binding also follows upstream's foreign-reasoning projection. |
| d842915e2 | Survives. |
| 93225455f lazy transports admission | Adapted: single capture owner now also runs upstream's model-call admission. |
| f1a505ada, ece2a9dc3, 1157b9dd0, 527857c15, f293b7364, a311d780d | Survive. |
| d65ae8c80 isolated image assembly | Adapted: no workspace agent identity in an isolated assessment. |
| 4d8551444 assessor image scope | Survives (temporary image session id passed in upstream's moved validation). |
| dfba3c0db, bba6b9fb1, 819c4635b | Survive. |
| 0f1efe4a8 recurring cleanup fairness | Adapted: migration 0552 is now 0667 with an idempotent body. |
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
4. First-use auto-membership (cbe4357c7): `accessGrantAuthorization` set `firstUseMembership` for every non-linked,
   non-service external actor and `provisionExternalMemberOnFirstUse` created the missing membership with seven
   default permissions whenever the key held `members:manage` (a legacy key with `workspace:admin` qualifies). That
   breaks Cendra's contract that `asUser` never creates membership. **Cendra fork feature (`a3da958f0`):** the setting
   `externalMemberFirstUseEnabled` (`OPENGENI_EXTERNAL_MEMBER_FIRST_USE_ENABLED`) defaults to false; until a deployment
   enables it, an external actor without a membership is refused 403 and nothing is written. Upstream's simple embed
   path needs it on. Regression: `external-first-use-membership` "with first-use membership off (the Cendra default) a
   capable key's user is refused" fails without the guard and passes with it; upstream's cases opt in (19/19).
5. Drain set for the repin (review P1-c): the ten `-- deployment-mode: maintenance` migrations since the base, all to
   run with API and workers stopped:
   - 0585, 0597, 0598, 0600, 0603, 0608, 0619, 0621 also refuse a live application role (`pg_stat_activity` check);
   - 0586 is inert SQL (`SELECT 1`) and a release marker: its header says the matching production migration Job
     activates session tenancy for every existing organization while all writers are parked, and fails without a
     receipt;
   - 0645 changes the runtime-posture relation/grant contract, has no role check, and must run after old binaries drain.
   After 0600 and 0603, run `db:provision-roles` before starting policy-aware binaries (fork `AGENTS.md`: both are drained
   cutovers that provision roles). 0598 converts Claude credentials and needs `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`
   wherever Anthropic `api_key` connection rows exist. Rolling migrations that read the application-role list: 0588,
   0589, 0590, 0604, 0632. The nine upstream migrations added in round 2 (0656-0664) are all rolling.
6. Ordinals: round 2 renumbered after the latest upstream head's last migration (0664): 0665-0667.
   `bun scripts/check-migration-ordinals.ts --base e1395d4f0...` passes (666 migrations, next 0668). Nothing has
   deployed this branch's earlier 0656-0658, so only the pin path matters; the idempotent bodies cover it anyway.

## Migrations

Upstream assigned 0550 and 0552 to other files (`0550_organization_oauth_pending_states`, `0552_usage_allowances`)
and leaves 0551 unused. The ledger (`packages/db/src/migrate.ts`) is keyed by file name and applies every unrecorded
file in name order, so names never collided as keys; ordinals collided, and on a fresh database the fork files ran
before upstream's later changes to the same tables.

| Old (pin) | New | Body |
| --- | --- | --- |
| 0550_external_workspace_member_empty_permission_updates | 0665 (round 1: 0656) | Accepts exactly the pre-image (`md5(prosrc)` `0b629b03...`, anchor once: rebuild) or the post-image (`b7505fb5...`, replacement once, no anchor: no-op). After a rebuild, `pg_proc` metadata (owner, ACL, SECURITY DEFINER, config) must be unchanged and the post-image md5 exact. |
| 0551_model_call_source_receipts | 0666 (round 1: 0657) | Every object guarded (column, table, policy, triggers, FK); exact column shapes asserted; `fork_session_content` rebuilt only when all five anchors are present once, a no-op when all five replacements are present once and no anchor, refused otherwise. |
| 0552_recurring_temporary_image_cleanup_fairness | 0667 (round 1: 0658) | Pre-image md5 pin `f9c5c9a6...` kept; exact post-image `59b622ef...` accepted as applied. |

All three set `lock_timeout`. No ledger alias was added: the 283 "fix0550" was itself a forward migration and
`migrate.ts` has no alias mechanism. Re-running converges a database whose earlier fork run preceded upstream's later
migrations, which an alias would not.

0547: `0547_idle_command_containment` landed upstream on 2026-10-02 (#3005, 4a63d4f51), after the 2026-09-30 merge
base. The pin lacks it by sync timing, not by choice; it is present now. On a database upgraded from the pin it runs
after 0548/0549 and the fork's old 0550-0552; it touches none of their objects.

Physical difference: on an upgraded database the fork columns `session_history_items.source_basis` and
`model_call_facts.source_receipt_id` precede upstream's later columns; on a fresh database they follow them. Column
order is not semantic, but a schema dump comparison must normalize it.

### Round 2 proof (0665-0667 on `e1395d4f0`; PostgreSQL 17.11, own container, removed afterwards)

Same non-superuser owner bootstrap. Bodies are byte-identical to round 1 apart from the header comment.

| Path | Result |
| --- | --- |
| (a) empty PG17 -> branch migrator | rc 0; 666 ledger rows, head 0667; 0547 present; 0665/0666/0667 recorded, no old names; md5s `b7505fb5...`/`59b622ef...`; receipts FK, policy, ENABLE+FORCE RLS, pinned guard `search_path` |
| (a) branch migrator again | rc 0; schema dump byte-identical |
| (b) pin `6c2c7eaf1` migrator -> branch migrator | pin rc 0 (559 rows, 0550-0552); branch rc 0; 669 rows (0547, upstream 0550/0552-0664, 0665-0667); same md5s and objects as (a) |
| (b) branch migrator again | rc 0; dump byte-identical |
| (c) 0665/0666/0667 applied directly twice on (b) | rc 0 all six; dump byte-identical |
| (a) vs (b), normalized | only the install timestamp upstream 0515 bakes into a function |

### Round 1 proof (as 0656-0658 on `89e3a2ad9`; real PostgreSQL 17.11, own container, data on tmpfs, removed afterwards)

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

This branch's migrator, after the install (second container, same owner bootstrap, removed afterwards):

| Path | Result |
| --- | --- |
| (a) empty PG17 -> branch migrator | rc 0; 657 ledger rows; 0547 present; 0656/0657/0658 recorded, no old fork names; both function md5s equal the post-images; receipts FK, policy, ENABLE+FORCE RLS and the guard's pinned `search_path` present |
| (b) pin migrator -> branch migrator | pin rc 0 (559 rows, old names); branch rc 0; 660 rows (0547, upstream 0550/0552-0655 and 0656-0658 added); same md5s and objects as (a) |
| (b) branch migrator again | rc 0; schema dump byte-identical |
| (a) vs (b) normalized schema dumps | One difference only: the install-time timestamp that upstream's pre-existing `0515_autonomous_learning_defaults` bakes into a function. Column order is normalized by the comparison. |

The proof ran without `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY` and without a live application role, as on an empty fleet.

## Tests (round 1, on `fe750ae24`)

Round 2 results are in the next section.


Toolchain Bun 1.3.14 (`bun --version`). The installs ran once free disk recovered above the floor plus the install
footprint (18-29 GB at the time). Real PostgreSQL 17.11 in an own container (data on tmpfs). One test file per Bun
process with the CI's sanitized environment (`OPENGENI_TEST_HERMETIC=1`, `OPENGENI_REQUIRE_REAL_DB=1`). The host's
load average was 25-60 on 8 cores throughout, so every merged-only timeout was rerun alone.

| Gate | Result |
| --- | --- |
| `bun install` | rc 0; `bun.lock` byte-identical (the lock already satisfies the merged manifests and the fork's patch) |
| `bun run typecheck` | rc 0, all projects clean (after the merge, and again after every fix) |
| `bun scripts/check-migration-ordinals.ts --base 89e3a2ad9...` | PASS (657 migrations, next 0659) |
| same, `--base 42a50cd1f...` (upstream head now) | FAIL rc 1, expected: 0656 collides with `0656_inbox_owner_recipient` |
| `bun scripts/check-migration-schema-contract.ts` | PASS (657 migrations, 355 forward additions) |
| `scripts/release-schema-contract.test.ts`, `scripts/embedding-migration-order.test.ts` | 14 pass, 0 fail |
| `bun scripts/check-docs-refs.ts` | PASS |
| `bun scripts/public-api/check.ts`, `bun scripts/generate-site-browser-runtime.ts --check` | PASS after regeneration (`708b36be5`). Both FAIL on the clean upstream checkout too: upstream's committed surface lacks its own inbox routes, and the pin's lacked the fork's two routes. |
| Ledger proofs (above) | PASS |

Package tests (api, worker, core, db, runtime, sdk, contracts): 1840 files on the merged tree, 16626 pass, 144 fail,
36 skip, in 57 files. Every failing file was rerun on a clean checkout of upstream `89e3a2ad9` (if it exists there)
and on a clean checkout of the pin `6c2c7eaf1` (if the fork touches it). Classification:

| Class | Files | Detail |
| --- | --- | --- |
| Inherited from upstream (red on `89e3a2ad9` too) | 34 | api: connections-routes, embedded-gmail-connect, managed-auth-session-sets.integration, native-mcp-shared-admission, organization-mcp, sandbox-shared-and-viewer, session-agent-access, session-agent-routes (same file, timeout-shaped: merged fails 1 case, upstream 5), session-attach-default-variable-sets, session-proxy-chats, slack-bot, slack-interactions-integration, workspace-control-busy-routes; worker: assistant-message-events, child-terminal-result-answer, codemode-dispatcher, connected-command-cleanup-integration, final-reply-postgres, initialized-native-worker, sandbox-lease (same cases on a rerun), usage-allowance-regressions-postgres; contracts: browser-bundle-boundary, insights-usage; db: connections, postgres-tls-retention, session-control-mega-migration; runtime: lazy-provisioning, modal-command-router-wire, modal-exec-readiness, modal-sdk-command-start-recovery, modal-supervision-control, ownership-inversion; sdk: adapters, core-bundle-boundary |
| Merge interactions, fixed (red before, green after) | 10 | session-create-observability (7/7), session-create-fresh-outcome repair case, tool-path-phase-timing (8/8), agent-turn PQA-0044, codex-realtime-controller (36/36, source fix `d8ad352d1`), slack-rest-mcp-preparation (4/4, source fix `8f9627e77`), tool-approval-upgrade (1/1), migration-0343 (2/2), agent-config-enforcement (90/90), durable-tool-op-finalization (4/4) |
| Load timeouts, green when run alone | 3 + 2 cases | session-effective-tools-routes (1/1), session-events-mcp (10/10), session-human-input-routes (5/5); the fresh-outcome cancelled-observation case (passes alone, and with a 60 s fence wait); one agent-turn timing assertion (145 ms vs < 100 ms) |
| Already red at the pin (same cases) | 10 | session-authorization-routes (5 cases), session-realtime-ledger and agent-session-commands (`claim.turn.modelContext`, c376f0d13), cache-notice-replay (2), optional-repository-access-loss (`MODEL_OUTPUT_PRODUCER_INEXACT`), runtime (recovery notice text), model-call-source-receipts (same file, timeout-shaped: merged fails 1 case, the pin 3), runtime-posture (table-class count 419 vs 418), browser-client-surface (`getSessionModelSourceBasis`), evidence-assessor-files (needs `OPENGENI_EVIDENCE_ASSESSOR_TEST_APP_URL`) |
| Inherited upstream defect inside a fork test | 3 cases | session-create-fresh-outcome: the three cases that read a 403/500 JSON body over HTTP (finding 1 below). With those, that file is 6 pass, 1 skip, 3 fail when run alone. |

## Tests (round 2, on `37c6a85b3`)

| Gate | Result |
| --- | --- |
| `bun install` (Bun 1.3.14) | rc 0; `bun.lock` byte-identical to upstream `e1395d4f0`'s |
| `bun run typecheck` | rc 0, all projects clean (the merge alone failed with TS2741 until `ec39c5657`) |
| `bun scripts/check-migration-ordinals.ts --base e1395d4f0...` | PASS (666 migrations, next 0668) |
| `bun scripts/public-api/check.ts --write`, Site runtime `--check`, action catalog `--write` | PASS; surface unchanged, catalog adds upstream's inbox routes |
| Ledger proofs (round 2 table above) | PASS |

Red before, green after, in round 2:

| Test | Before | After |
| --- | --- | --- |
| `http-rejection-telemetry` gzip case (`b0c49cf11`) | empty body | 10/10 |
| `organization-mcp` (`72d7e4d12`) | red (also upstream) | 22/22; red again without one exemption |
| `external-first-use-membership` Cendra-default case (`a3da958f0`) | membership created | 19/19 |
| `chat-quickstart-onboarding`, `member-learning-read` (opt in, `37c6a85b3`) | 403 under the new default | 7/7 |

Package suite (api, worker, core, db, runtime, sdk, contracts; 1867 files), merged tree:

- First pass: 1374 files, 96 failing. 62 of the 96 were collateral: upstream's `sandbox-lease` (red upstream) drops
  its BYPASSRLS role in `finally`, the drop fails while another test's database still depends on it, and the shared
  `opengeni_app` stays a member, so every later role-normalizing fixture refuses. The run was stopped, the test
  server recreated, and the failures rerun with `sandbox-lease` excluded.
- Rerun of the 95: 30 still fail. Then 62 of the remaining 492 files ran (3 fail) before free disk fell to 4.5 GB
  from other sessions; the run was stopped. **431 files were not run in round 2** (round 1 ran all 1840 on
  `fe750ae24`).

The 33 failing files, classified:

| Class | Files |
| --- | --- |
| Red on clean upstream `e1395d4f0` (new in round 2) | 9: agent-config-enforcement (84, `db.select` on the test's fake db through upstream's new `requireWorkspace`), agent-run-admission, goal-continuation-admission, goal-continuation-credential-restriction, scheduled-task-creator-policy, agent-widening-fences, child-lifecycle-notices, connector-action-parallel, migration-0264 |
| Red on upstream `89e3a2ad9` (round 1) | 13: connections-routes, embedded-gmail-connect, managed-auth-session-sets.integration, native-mcp-shared-admission, slack-interactions-integration, assistant-message-events, final-reply-postgres, usage-allowance-regressions-postgres, browser-bundle-boundary, insights-usage, connections, postgres-tls-retention, session-control-mega-migration |
| Red at the pin (round 1, same cases) | 7: evidence-assessor-files, session-authorization-routes, cache-notice-replay, optional-repository-access-loss, model-call-source-receipts, agent-session-commands, runtime-posture |
| Fork divergence (finding 4) | 1: context-compaction-activity, upstream's new byte-continuation case |
| Same error as migration-0264 (`task.owner_subject_id`), not separately verified | 2: migration-0345, migration-0478 |
| Unclassified | 1: migration-0363 (`toMatchObject`) |

## Round 3: repin blockers on the fork side

**Type annotations (`5567862ca`, upstreamable).** Two sources from upstream `e1395d4f0` compile under the fork's
`exactOptionalPropertyTypes` option set but not under plain `strict`, which Cendra's consumers use:
`packages/runtime/src/anthropic-messages.ts` (the conditional `retry-after` header object, TS2345 at two uses; now
`Record<string, string>`) and `packages/react/src/components/composer.tsx` (`src` later assigned `undefined`, TS2322;
now `string | undefined`). Patch from MAINT-P09-434 (`docs/tasks/MAINT-P09-434/patches/fork-conformance-strictness-types.patch`),
`git apply --check` clean, applied unchanged. `bun run typecheck` rc 0; anthropic tests 78/78; composer tests 110/110.
The Cendra-side proof (`opengeni:compile:pins`, web2 strict typecheck) is the repin's.

**Artifact runtime for H**, built as for the pin (`cendra/artifact-runtime-6c2c7eaf` @ `34205e850`, run
37721763225: one caller workflow on top of the exact source that runs the reusable `artifact-runtime.yml` with
`source_sha`; that reusable workflow is unchanged since the pin):

| Item | Value |
| --- | --- |
| Branch / caller commit | `cendra/artifact-runtime-5567862c` @ `8c9f86d1e5eab5b84b204ca83a45e624ec77a4ac` (parent H; adds `.github/workflows/cendra-artifact-runtime-5567862c.yml` only) |
| Run | 37878090595, "Cendra artifact runtime for 5567862c", success, 2026-10-09T03:11:01Z-03:20:06Z, 9/9 jobs (8 native/WASM smoke receipts + container assembly) |
| Containers artifact | `artifact-runtime-containers-5567862ca254da34712f52d9c32ca1dc05e20aef`, id 11593217578, 5400840 bytes, digest `sha256:ddb91a43875c86999af881f5dcaa2e8647c7a27c11214462a166768701de8ab8` (the downloaded ZIP's sha256 matches) |
| Container receipt | `artifact-runtime-container-receipt.json`, sha256 `7936582358286b1c93585627c8774cc8747b93b286bf7806afe13de5eea36753`, `sourceSha` = H, 2 installations (amd64, arm64) |

Target artifacts (id, digest): darwin-arm64 11593073522 `9c1add83...`; darwin-x64 11592854323 `cd25afb6...`;
linux-arm64-gnu 11592938685 `4b48b425...`; linux-arm64-musl 11593043644 `d28cb466...`; linux-x64-gnu 11593540290
`a4aec9ca...`; linux-x64-musl 11593860194 `22172be9...`; wasm-web 11593865123 `07c5cdff...`; win32-x64-msvc 11594015259
`70e20faa...`.

## Findings (round 1) and their resolution (round 2)

1. **Empty JSON error bodies under gzip: fixed in `b0c49cf11`, an upstreamable fix that must land before the repin
   (review P1-b).** On Bun 1.3.14, upstream 1489689ad's `readRejectionEnvelope`
   (`apps/api/src/http/rejection-telemetry.ts`) read the `response.body` getter before `clone()`; once the clone was
   read, the original body was empty, and the outer `compress` middleware sent a 20-byte empty gzip body for every
   403/500 JSON error. Reproduced with plain Hono (compression outside, the envelope read inside). `clone().text()`
   itself is safe; the null-body guard was redundant (a null body clones to `""`, which parses to `undefined`), so the
   fix removes that one getter access and keeps upstream's telemetry unchanged. Regression in
   `apps/api/test/http-rejection-telemetry.test.ts` ("a gzip-compressed rejection keeps its JSON body after the
   envelope is read"): red before (empty body), green after; file 10/10. Upstream CI runs Bun 1.4.0, where this was not
   tested.
2. **Organization MCP catalog: decided and implemented in `72d7e4d12`.** The four fork-only routes are the embedding
   host's own bookkeeping, not organization actions, so agents never reach them through the organization MCP. They are
   exempted by exact method and path in `CENDRA_HOST_ROUTE_EXEMPTIONS` (`scripts/public-api/action-catalog.ts`), one
   reason each: `DELETE /files/:fileId` (release of a session's temporary model image upload; the path is shared with
   the catalogued file read, hence method-exact), `GET /files/temporary-model-images` (custody listing),
   `GET /sessions/:sessionId/model-source-basis` (exact model-call source receipt for host source admission),
   `PATCH /external-members/:subjectId` (legacy permission update owned by host reconcile). The regenerated catalog
   adds only upstream's own inbox routes. `organization-mcp.test.ts`: red before (also red upstream), 22/22 after;
   dropping one exemption turns it red again.
3. **Claimed turn carries `modelContext` (pre-existing fork divergence): unchanged, for the fork owner.** c376f0d13 put
   `modelContext` on the execution-turn projection, which is also the claim result; upstream tests in
   session-realtime-ledger and agent-session-commands forbid it there. Red at the pin and on the merge alike.
4. **Legacy unattributed history (fork owner).** The fork refuses model outputs whose producing call's source receipt
   is incomplete (`MODEL_OUTPUT_PRODUCER_INEXACT`); a session whose history holds a generated row or summary without
   source basis therefore cannot persist further model output. Already red at the pin (`optional-repository-access-loss`)
   and now also hit by upstream's new `context-compaction-activity` case "post-compaction byte continuation" (receipt
   reason `UNRESOLVED_PARENT`, seeded legacy assistant row). Unchanged here.

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
- Database: the drain set and provisioning steps in coordinator check 5; the renumbered fork migrations re-run as
  verified no-ops on staging.
- New fork setting `OPENGENI_EXTERNAL_MEMBER_FIRST_USE_ENABLED` (default false): Cendra keeps it off, so `asUser`
  never creates membership.
- The 25 upstream commits of round 2 change no declaration the adapter imports (`createDb` appears only in tests);
  `OPENGENI_API_CONTRACT_REVISION` is unchanged.

## Open risks

- Findings 3 and 4 are fork-owner items; finding 1's fix must land with the repin.
- MAINT-P09-430's local commit adds `0553_usage_event_call_attributes.sql`, which collides with upstream's 0553; it must
  land at 0668 or later on top of this branch.
- The next sync renumbers the fork migrations again if upstream passes 0667 (safe by their bodies).
- Repin observations: carrier approval mode under managed tool decisions, first-turn tool search for cendra-pms, the
  0598 encryption key on staging, and the 0586 session-tenancy activation Job.
- Round 2 ran 1436 of 1867 package test files (disk); migration-0363 is unclassified and migration-0345/0478 are
  unverified against upstream.
- Upstream's `sandbox-lease` leaks a BYPASSRLS role membership on a shared test server; run it alone.
- Gate logs are kept untracked in the worktree's `.local/gates` until review. `.local/` is not git-ignored in the
  fork, so a follow-on must not `git add -A`.
- Lesson for the next sync: moving fork migrations after the upstream chain moves fork DDL past every upstream test
  that holds an intermediate ledger and writes through the current Drizzle schema (tool-approval-upgrade,
  migration-0343 here). Grep for that fixture idiom before running the suite.
