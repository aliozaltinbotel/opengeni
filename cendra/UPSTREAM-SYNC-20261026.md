# Upstream sync 2026-10-26 onto fork25 (F0)

Branch `cendra/upstream-sync-20261026` of `aliozaltinbotel/opengeni`. It starts at Native's qualified fork25 head
`a9f495d8f550fe04ee5c3ed08258d3ef55caea4f` (on `codex/native-a28-qualified-successor-20261025`; the Cendra pin
`13a55d8b7` is its predecessor) and merges upstream `Cloudgeni-ai/opengeni` `main` with `--no-ff`. No fork commit was
rebased or rewritten. Fork `main`, `production` and the Native branches were not touched. Do not merge this branch:
it is for review and a repin by Native.

| Item | Value |
| --- | --- |
| Upstream SHA merged | `01f15f453b19c70ddcc5b647341708b07a8382fa` ("chore(agent): release 0.1.142 (#6303)"), committed 2026-10-26T18:34:55Z, fetched 2026-10-26T19:37:12Z |
| Merge base | `0355223eeb6ebda5ad4d8d37290cdb5106737045` |
| Fork side / upstream side | 185 commits (160 non-merge) / 1063 commits |
| Merge commit | `1c6f1fedde7d47004afaadade2b2892ab7a45279` (parents `a9f495d8f`, `01f15f453`) |
| Follow-ups | `ee9825191` regenerated `bun.lock`; `94c7b2bb7` fork call sites fitted to upstream signatures; `ba4430956` fork migrations renumbered to 0997-1008; `414d55809` four newer fork host routes exempted from the organization MCP catalog (catalog regenerated); `b6fe4e67f` regenerated surface and Site browser runtime; `5aee0983d`, `a484934a1`, `3f1878689` test fits; this report; fix round 1: `8c07a6fe1` every renamed migration accepts its own exact post-image, `2d2c8b5d6` deferrable model-call-fact receipt key (0998, 1009, 1010), `9a82a150e` existing-only identity fence `FOR NO KEY UPDATE` (1011 and a PostgreSQL test), `a91525eb5` title usage keeps the subscription connection, `f54969111` test fits |
| Toolchain | Bun 1.4.3 (the fork's `packageManager`, from `CendraAgenticPMS/.local/toolchains/bun-1.4.3`; the host default is 1.3.14) |

History. The shared clone is shallow at `662b922f3` and partial (`blob:none`); the merge base resolved without
deepening, and the 1063 upstream commits since it were fetched in full (blobs on demand).

Environment notes for re-running the gates on this host: `~/.bun/install/cache` is a dangling symlink, and Bun's
runtime transpiler cache loops forever on it (every `bun <script>` hangs), so all commands ran with
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` and an own `BUN_INSTALL_CACHE_DIR`. Database gates ran on an own
`pgvector/pgvector:pg17` (PostgreSQL 17.11) container on tmpfs through `OPENGENI_TEST_PG_URL`, never the shared
`opengeni-shared-test-pg-61440` harness container, and Temporal-backed tests on an own `temporal server start-dev`.
Both were removed afterwards.

## Conflicts and resolutions (51 files)

Resolution rule: upstream's structure is the base; every fork intent is re-applied on top of it. Generated files take
upstream's bytes at merge time and were then regenerated (`b6fe4e67f`, `414d55809`).

| File | Resolution |
| --- | --- |
| `apps/worker/src/activities/agent-turn/agent-build.ts` | Union: fork prepared-Skill-catalog snapshot equality check (throws on drift) first, then upstream's `ensureSessionWorkspaceGovernance` durable governance item. |
| `apps/worker/src/activities/run-input.ts` | Upstream's `activeHistory.items` load, then the fork's `bindDurableModelHistoryRows(stored)` source binding. |
| `apps/worker/src/activity-services.ts` | Union: fork `startRealtimeUsageWorkflow` + upstream `startRecordingWorkflow`; the fork's title-workflow gate (`!authorizeModelCallSource && ...`, title operations keep the native parallel producer that supplies an attempt-bound receipt) kept. |
| `packages/db/src/schema.ts` | Union: fork `modelCallSourceReceipts` table + upstream `promotionDecisions`/`promotionEnforcement`. |
| `packages/react/src/app/lib/bootstrap-error.tsx`, `bootstrap-error.test.ts` | Union: fork `recovery?: "authentication"` (Clerk recovery hint) beside upstream `recovering?: true`; both sides' tests. |
| `apps/web/src/context.tsx` | Union of imports (fork `useExternalAuthRecovery`, upstream `ArchiveConfirmationProvider`); the fork's Clerk authentication-recovery branch is evaluated before upstream's new transient "recovering" waiting panel (401/403 are never transient, so the branches are disjoint). |
| `apps/web/src/bootstrap-error-surface.test.tsx` | Both sides' tests (fork external workspace-grant bootstrap case, upstream `bootstrapResponse` helper). |
| `packages/react/src/app/app-state.tsx` | Fork `hasExternalAccessTokenSource`/`signOutExternalAccess` host hooks kept; upstream's `startManagedSocialSignIn(provider, signupChallengeToken?)` signature taken. |
| `apps/worker/src/activities/agent-turn/run.ts` | Upstream wrapped the stream attempt in `try { ... } finally { await eagerOwnedSandboxSetup.settled() }` and added `eagerOwnedSandboxSetup` to its input. Re-applied inside the `try`: the fork's named `streamAttemptInput` (with `beforeModelCallSourceReceipt` and upstream's `eagerOwnedSandboxSetup`) and the NPD-013 declared-fallback-in-attempt `catch` (`prepareDeclaredFallbackInAttempt` / `fallbackRunInputs`), so the eager-setup `finally` also covers the fallback run. |
| `apps/api/test/session-realtime-routes.test.ts` | Union of imports (fork moved `signDelegatedAccessToken` to its earlier import; upstream added `UpdateOrganizationModelDefaultsRequest`). |
| `packages/documents/test/knowledge-preparation-postgres.test.ts`, `packages/runtime/test/context-compaction.test.ts`, `packages/db/test/personal-workspace-session-tenancy.test.ts`, `apps/api/test/knowledge-gateways-postgres.test.ts`, `packages/db/test/session-realtime-ledger.test.ts`, `apps/api/test/http-auth.test.ts`, `packages/core/test/external-identity-request-lock-order-postgres.test.ts`, `packages/db/test/skill-catalog-context.test.ts`, `packages/db/test/editable-artifact-materialization-postgres.test.ts`, `apps/worker/test/agent-build-session-title.test.ts` | Upstream split `@opengeni/testing` imports into subpaths (`/shared-pg`, `/settings`, perf #5343); the fork's extra imports kept on the new subpaths (the fork fixtures `acquireRestrictedRuntimeTestDatabase` and `acquireOwnerMigratedTestDatabase` live in `shared-pg.ts`). |
| `apps/api/test/session-authorization-routes.test.ts` | Union of db imports. |
| `apps/worker/src/activities/agent-turn/history-sink.ts` | Union of imports (upstream history-footprint compaction pressure; fork source-binding helpers). |
| `packages/core/test/access-permissions.test.ts` | Both sides' tests. |
| `apps/api/test/session-create-observability.test.ts` | Upstream's Site-view mocks (`SITE_FRAME_HEADER`, `hasPermission`, `siteViewConversationContext`) + the fork's `createSessionForRequestWithOutcome` mock name (ea564b0a7). |
| `apps/api/src/routes/knowledge.ts` | GET search keeps the fork's `search()` (query-owner workflow path with grant and continuations, 567468713/fd9ef3d14) and takes upstream's `parseRequestQuery(..., KNOWLEDGE_REQUEST)` validation. |
| `packages/db/src/skills.ts` | Union: fork `skillSelectionSourceRef` + upstream `activeSkillDescriptorSource`. |
| `packages/runtime/src/model-provider-client.ts` | Union of imports (fork `authorizeModelSourceProviderDispatch`, upstream `observePromptCacheRequestBody`). |
| `packages/db/src/slack-routing-personal-workspace.ts` | Upstream split the body into `activeMembershipPersonalWorkspaceId` and added `externalPersonPersonalWorkspaceId` (`external_user:` only). The fork's wider `namedSubjectPersonalWorkspaceId` guard (`SessionScopeSubjectId`: `user:` and `external_user:`, 2e97d9f5f) and its account-scoped `withRlsContext` body (now in the shared helper, so upstream's external variant gets it too) kept. |
| `apps/worker/src/activities/agent-turn/model-usage.ts` | Upstream's new contracts import block + the fork's db imports (`applyCreditDebitUpToBalance`, `existingUsageEventIdempotencyKeys`, `isTransactionHandle`, `recordUsageEvent`); upstream's `promptCacheRequest` read. |
| `packages/runtime/src/tool-result-spill.ts` | Upstream's 4th `wrapAttemptToolExecute` parameter `projectForModel` kept in place; the fork's `sourceRefs` moves to the 5th parameter. The fork's raw-result source capture (`recordModelToolSource`, exact raw digest) still runs before upstream's per-caller projection/spill. Fork call sites (`wrapAttemptToolDefinitions`, runtime `index.ts`, `packages/runtime/test/tool-result-spill.test.ts`) pass `undefined` for the projection. Note: for a server with a model projection (Gmail), the receipt digests the exact result while the model sees the projection. |
| `packages/runtime/src/index.ts` | Union of the model-request-capture exports and upstream's `takeWithheldCompactionInput`; prepared MCP definitions keep the fork's `modelSourceRefs` destructuring and pass it after upstream's server model projection. |
| `packages/testing/src/compose.ts` | Upstream made the fixture's runtime imports lazy (#5343); the fork's NATS control-plane auth kept with a type-only import and a lazy `resolveNatsControlPlaneAuth` import; `waitForNats(natsUrl, natsControlAuth?)` keeps the fork's parameter with upstream's lazy `nats` import. |
| `apps/api/src/integrations/oauth-profiles.ts` | Union: the fork's `CENDRA_READ_PROFILE` (Cendra Single MCP read, exact Clerk issuer, 914227fd2/e02dc5b50) + upstream's Drive and Calendar profiles, all in `BUILT_IN_OAUTH_PROFILES`. |
| `packages/db/test/runtime-posture.test.ts` | Union of the table-class counts (fork 0666 receipts table + upstream 0908-0971 tables). |
| `packages/core/test/session-create-latency-postgres.test.ts` | Union of imports and of both sides' tests (fork birth-receipt recovery cases, upstream child file-ownership case). |
| `packages/core/src/transcription-service/service.ts` | Upstream moved `apps/api/src/transcription/service.ts` here and rewrote providers (`DictationProvider` with `provider`/`model`, credentials per call). The fork's MAINT-P09-430 dispatch/terminal `recordTranscriptionModelCall` receipts re-applied around upstream's `provider.provider.transcribe(...)`; model is now `provider.model.model`, pricing upstream's `provider.model.creditPricing`, billing path from upstream's `charged`. Import moved to `../domain/voice-input-billing`. |
| `apps/worker/src/index.ts` | Union: fork `StartRealtimeUsageWorkflow` + upstream `StartRecordingWorkflow` in imports and both signaler checks. |
| `apps/worker/src/activities/agent-turn/compaction-prep.ts` | Upstream's prompt-cache fingerprint observer (`observeCompactionRequests`, `promptCacheRequest`) and remote `withheldWireHistory` kept; the fork's exact-call compaction source keys (`beforeModelCallSourceReceipt(request, "COMPACTION")`, `onUnreportedUsage`, `successfulSourceKey`/`successfulRemoteSourceKey`) re-applied inside both portable summarizer branches and the remote v2 requester. |
| `apps/worker/src/activities/context-compaction.ts` | Union of the requester type (`withheldWireHistory` + fork `successfulModelSourceKey`) and upstream's `CompactionInputRecoveryPayload`. Upstream's new exact withheld-wire-history path (remote v2 and portable) is **gated for the fork**: it is used only when every withheld item is attributable to a durable history row (retained `session_history_items` binding or projection identity, new helper `compactionSourceId`); otherwise the durable items are re-projected as before, so the summary keeps exact `summarySourceIds`. The withheld request is still always consumed. `successfulInput` (remote) and `sourceItems` (portable) follow the input actually sent. Adapted; see concern on prompt-cache reuse. |
| `apps/worker/src/activities/agent-turn/stream-attempt.ts` | Union of imports (upstream `PromptCacheRequestFingerprint`, fork turn-budget). The fork's `settleCapturedModelTerminal` (exact-call `nativeSourceKey` by response) kept as the single terminal-settlement owner; it now also passes upstream's `promptCacheRequest` and `subscriptionConnectionId` (the latter was in the merge base and in upstream; the fork's helper, b465f1817, had dropped it when it was replayed onto the base; restored). Fix round 1 (`a91525eb5`) restores it on the session-title usage call too, which the fork had dropped the same way. Upstream's `eagerOwnedSandboxSetup` added after it. The F-2 `turnRouteWatch.responseSettled` budget count kept. Tool-output events: upstream's accepted-wait verbatim reply is pushed first, then the fork's SDK execution timing (b1ebb50b8) and parallel-batch deferral (0592c01e4). |
| `packages/runtime/src/lazy-tool-transport.ts` | Union of imports. The fork moved `tool_list` into the private `listAuthorizedTools` method (to record list sources); upstream's only change inside it, `...(cursor === undefined ? this.unavailableSources() : {})` on both group and tool pages, re-applied in the method. Disclosure flush: upstream's notice items (`noticeAfter`/`cachedNoticeItem`) and the fork's `bindModelGenericToolDisclosure(item, readySelections)` both kept. |
| `packages/core/src/access/index.ts` | Union of imports (fork `validateCanonicalHumanSession`, upstream `externalPersonPersonalWorkspaceId`). Upstream routed the four explicit-key delegation ceilings through a new `ceilingCovers` (exact or personal-setup coverage). The fork's 5b32e0b7c rule (explicit-mode `hasPermission`, so Q-16 secret aliases delegate as they authorize, never the admin wildcard) is re-applied inside `ceilingCovers`; since the merged `hasPermission` already includes upstream's personal-setup rule, both intents hold at every call site. |
| `packages/core/src/domain/sessions.ts` | Union of imports (fork creation-receipt recovery, upstream Teams admission and message time zone). Session create: the fork's isolated image-only scope check (evidence assessor, 4d8551444) runs first, then upstream's Teams proof composition into `externalBeforeCreateCommit`. Fork `importedHistoryOrigins` beside upstream `timeZone`; fork F-2 `fallback`/`turnBudget` options beside upstream `teamsConversation`. Send: upstream's app-action grant and `waitsForMachineOwner` result, with the fork's `messageModelSourceRefs` and F-2 `turnMetadata` route declaration re-added. |
| `apps/api/src/routes/sessions.ts` | Union of imports (fork cancel/creation-receipt/realtime proxy routes, upstream `readSessionResponsePair`, `turnAppActionGrant`). Create response: upstream's overlapped `readSessionResponsePair` on the fork's `result.session` (ea564b0a7), and the response still carries `freshCreated: result.outcome === "created"`. Realtime ledger sync: upstream's `parseRequestBody` (throws 422) replaces the `safeParse` branch; the fork's per-delegation route resolution (0352becc7) now reads `parsed.entries` and still runs before the ledger transaction, with `delegationExecutionPolicies` passed to it. Send/steer: fork `messageModelSourceRefs` beside upstream `timeZone`. |
| `packages/contracts/src/index.ts` | Upstream made schemas lazy (`defineSchema`) and moved to `primitives`; every fork field is re-applied on upstream's schema: file resource `asImage`, realtime delegation route fields (`model`/`reasoningEffort`/`latencyMode`) and their delegation-only refinement, `CreateSessionResponse.freshCreated`, `importedHistoryOrigins`, `messageModelSourceRefs` and F-2 `fallback`/`turnBudget` on user-message and steer payloads, `UsageEvent.attributes`. The fork's usage-call and F-2 schemas (`MODEL_CALL_*`, `EMBEDDING_CALL_*`, `TurnFallbackRouteRequestV1`, `TurnBudgetV1`) keep their bytes. Union of the top imports/re-exports. |
| `packages/db/src/index.ts` | (1) model call facts: union of the fork's source-receipt lookup and upstream's prompt-cache diagnostics. (2) Upstream generalized the Skill-catalog snapshot into `ensureSessionContextSnapshot` with channels (Skill catalog, new workspace governance). The fork's source basis (INSTRUCTION, `skill-catalog:<digest>` parent, retained Skill sources, native artifact sources frozen in turn metadata, with the `SKILL_CATALOG_*_CHANGED/INVALID` refusals) is re-applied through an optional `source` input that only `ensureSessionSkillCatalog` passes; governance rows carry no basis, which the receipt closure accepts as a plain history row. (3) `appendSessionHistoryItems`: the fork's canonicalized `expected` rows (open-suffix and exact-producer source bases, conflict reread with `sourceBasis`) kept; upstream's footprint columns added to `RETURNING` with its `appendedFootprint` accounting. (4) Upstream moved the active-history reader to `active-session-history.ts`; the fork's `sourceSha256` row digest re-applied there (`ActiveSessionHistoryRow`, page select), computed from the stored row, never the elided recovery projection. (5) Initial turn metadata: upstream's `initialTurnMetadata` (time zone) plus the fork's `nativeMessageModelSourceRefs`. (6) Queued batch claim: upstream's waiting-for-machine-owner messages and time zone, with the fork's per-message source basis (imported-history basis or host-message INSTRUCTION basis with retained refs) computed from the model-visible item (a waiting marker leaves an import unattributed). |
| `docs/architecture.md` | Both new paragraphs (fork creation receipt/cancel; upstream signup challenge and promotion funding). |
| `scripts/release-schema-contract.test.ts` | Upstream's appended-path list plus the fork's two entries; the renumber commit later renames all fork entries and registers 1005/1007. |
| `packages/sdk/src/site-browser-runtime.gen.ts`, `scripts/public-api/surface.gen.json` | Upstream bytes at merge time; regenerated from the merged tree in `b6fe4e67f`. |

Follow-up fits outside the conflict set (all in the commits above):

| File | Fit |
| --- | --- |
| `packages/runtime/src/index.ts` | The fork's prepared-tool `modelSourceRefs` type now follows `wrapAttemptToolExecute`'s fifth parameter (`94c7b2bb7`). |
| `apps/api/src/mcp/documents.ts`, `apps/api/src/mcp/knowledge-entries.ts` | Upstream moved the `knowledge_search` input schema to `KnowledgeSearchToolRequest`; the fork's query-owner path still parses the input with `KnowledgeEntryListRequest`, imported again (`94c7b2bb7`). |
| `apps/api/src/integrations/oauth-profiles.ts` | Upstream removed `exactMcpBinding` and `connectionSelection`: reconnect now matches the stored MCP URL exactly for every profile, and plain connect resolves the returned identity atomically. The Cendra read profile drops both fields; exact resource URL, personal ownership and the exact Clerk issuer stay required (`94c7b2bb7`). |
| `scripts/public-api/action-catalog.ts` | Four fork-only host routes added after 2026-10-08 (`POST .../sessions/:id/cancel`, `GET .../cancel/settlement`, `GET .../creation-receipt`, `POST .../goal/continuation-input`) get the same exact method-and-path organization MCP exemption as the four 2026-10-08 routes, so agents do not reach them through the organization MCP (as at fork25, whose catalog was never regenerated). The regenerated catalog equals upstream's apart from the fork's `includeSubSessions` query field, and `updateGoal` keeps its operation id (`414d55809`). |
| `apps/api/test/cendra-oauth-profile.test.ts`, `apps/api/test/session-create-observability.test.ts`, `apps/worker/test/agent-build-skill-catalog.test.ts`, `apps/worker/test/evidence-assessor-image.test.ts`, `apps/worker/test/parallel-tool-batch-persistence.test.ts`, `apps/api/test/model-catalog-scope-postgres.test.ts` | Test fits where upstream added a seam the fork's stubs did not know: no `exactMcpBinding` flag; `freshCreated` on upstream's new overlapped-reads case; `ensureSessionWorkspaceGovernance` stubbed beside the Skill catalog as upstream's own tests do; `turn.resources` and the history-footprint hooks on the scripted-turn fixture; upstream's new catalog-scope suite opted into first-use membership like 37c6a85b3 did (`5aee0983d`, `a484934a1`, `3f1878689`). |
| `packages/runtime/test/tool-result-spill.test.ts` | Fork case passes `undefined` for upstream's projection parameter (in the merge commit). |

Retained delta. Every non-trivial line the fork delta adds (merge base to fork25; 19,956 lines of 25 or more
characters, comments excluded) was looked up in the merged tree, following the moved transcription service and
the renamed migrations: 162 lines in 28 files are not present verbatim, and every one is a deliberate re-expression
listed in the tables above (re-formatted resolutions, upstream's lazy `defineSchema` schemas, the generic context
snapshot, `ceilingCovers`, the renumbered migration error texts, the oxfmt reflow of the two db tests the renumber
script touched, and the dropped obsolete OAuth profile fields). Nothing was dropped.

## Migrations

Upstream assigned 0895, 0896, 0954, 0955 and 0958 to its own migrations after the merge base (91 new upstream files,
0895-0996), and the fork's 0665-0670 had already shared ordinals with upstream's 0665-0671 at the base. All twelve
fork migrations move after upstream's head, in their existing order, with `scripts/renumber-migration.ts --base
01f15f453` (`ba4430956`). Bodies are byte-identical except the script's own-ordinal error texts (1003, 1004) and
1001's comment naming its predecessor.

| Old (fork25) | New |
| --- | --- |
| 0665_external_workspace_member_empty_permission_updates | 0997 |
| 0666_model_call_source_receipts | 0998 |
| 0667_recurring_temporary_image_cleanup_fairness | 0999 |
| 0668_usage_event_call_attributes (+ companion test) | 1000 |
| 0669_usage_event_call_attributes_schema_required | 1001 |
| 0670_knowledge_index_receipt_owner | 1002 |
| 0895_private_child_membership_authority | 1003 |
| 0896_editable_artifact_materializer_projection | 1004 |
| 0954_existing_only_external_identity | 1005 |
| 0955_human_knowledge_review_first_proposals | 1006 |
| 0957_pending_tool_model_output_sources | 1007 |
| 0958_session_creation_receipt | 1008 |

`scripts/release-schema-contract.test.ts` keeps upstream's derived checks; the fork names in its forward list follow
the renames, and 1005 and 1007 (never registered on the fork) are now registered.

Upstream's 0925 (membership fences, `FOR NO KEY UPDATE`) and 0980 (workspace governance fork predicate) patch
`fork_session_content` by anchored replacement, not by rewrite; neither touches the anchors of the fork's source-row
copy (now 0998), so on a fresh database 0998 rebuilds the copy owner after them, and on a fork25 database (whose copy
already carries the fork's replacements) 0998 re-runs successfully (both verified below).

### PostgreSQL 17.11 proof (own container, data on tmpfs, removed afterwards)

Non-superuser owner (`NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`), extensions created by the superuser,
`OPENGENI_MIGRATIONS_PREINSTALLED_VECTOR=true`, no live application role.

**Rule (since fix round 1): every fork migration accepts its own exact post-image.** A renamed file re-runs on every
database that recorded its earlier name (staging runs the pin `13a55d8b7`, which carries all twelve fork25 names), so
each fork migration applies its pre-image, accepts its exact post-image as already applied, and refuses anything else.
No ledger alias is used (`migrate.ts` has none).

First pass (`ba4430956`): the merged migrator on a fork25-migrated database stopped at
`1000_usage_event_call_attributes.sql` (`constraint "usage_events_attributes_shape_check" ... already exists`); 1000,
1002, 1004, 1005, 1006, 1007 and 1008 all failed a re-run there (1002/1004/1006 on their pre-image pins, 1005 on
`CREATE FUNCTION`, 1007/1008 on `ADD COLUMN`). Fix round 1 (`8c07a6fe1`) gave them the 2026-10-08 shape:

| Files | Shape |
| --- | --- |
| 1000, 1005, 1007, 1008 (DDL) | Columns `ADD COLUMN IF NOT EXISTS` with a type assertion; checks and triggers created when absent, else compared with the exact post-image (constraint definition and validation; trigger function, type, enabled state and column list); guard and reader functions created or replaced only when absent or byte-identical (md5 of `prosrc`). 1000 also accepts 1001's successor check. |
| 1002, 1004, 1006 (function patches) | Early return on the exact post-image (md5 / sha-256 of the body; 1004 also its two owner-only SELECT policies), before the existing pre-image pins. No upstream migration in 0895-0996 touches `knowledge_index_work`, `validate_editable_artifact_projection` or `knowledge_entry_apply`; the post-image digests were read from a fork25-migrated database and equal the merged fresh install's. |
| 0997, 0998, 0999, 1003 | Already do nothing when their post-image is present (2026-10-08 guarded bodies; 1003's post-image check). |
| 1001 (fix round 2) | Its fix-round-1 body only reached the same end state: it dropped, re-added and validated the call check in one transaction on every fork25 database, holding ACCESS EXCLUSIVE on `usage_events` for the scan. Now the exact COALESCE post-image is a no-op (validated, or awaiting 1012), 1000's definition is rewritten `NOT VALID`, anything else refuses; the new 1012 validates under SHARE UPDATE EXCLUSIVE. |

Three forward fork migrations follow (fix round 1): 1009 and 1010 make the model-call-fact receipt key a deferrable
NO ACTION check (re-added `NOT VALID`, then validated, as 0927/0928; 0998 now creates it deferrable on a fresh
install), and 1011 moves the existing-only identity resolver's membership fence to `FOR NO KEY UPDATE`.

Proof at the fix-round-2 head (final migration bytes; round 1 had the same results at `9a82a150e` with 988/1000 rows):

| Path | Result |
| --- | --- |
| (a) empty PG17 -> merged migrator | rc 0; 989 ledger rows, head `1012_usage_event_call_attributes_schema_required_validate.sql`; both spool overloads of `fork_session_content` carry the fork's `source_basis` copy and upstream's `FOR NO KEY UPDATE` fence |
| (a) merged migrator again | rc 0, applied 0 |
| (b) empty PG17 -> fork25 migrator (`a9f495d8f`'s `packages/` and exactly its 894 migration files) | rc 0; 894 rows, head `0958_session_creation_receipt.sql` |
| (b) then the merged migrator | rc 0; applied 107 (upstream's 91, the 12 renamed fork files, 1009-1012); 1001 rows |
| (b) merged migrator again | rc 0, applied 0 |
| (a) vs (b) normalized schema dumps (`pg_dump --schema-only`, owner name and column order normalized) | equal except the install timestamp upstream's 0515 bakes into a function |
| Both end states | receipt key deferrable, not deferred, validated; `read_existing_external_identity` md5 `fa17db36...` (`FOR NO KEY UPDATE`) |
| Drift refusals (rolled-back transactions on (b)) | a changed shape check -> `USAGE_EVENT_ATTRIBUTES_SHAPE_DRIFT`; a changed `knowledge_entry_apply` body -> `knowledge_entry_apply HUMAN proposal predecessor drifted`; a changed resolver fence -> `EXISTING_EXTERNAL_IDENTITY_FENCE_PREIMAGE_DRIFT`; a missing receipt key -> `MODEL_CALL_FACT_SOURCE_RECEIPT_FK_MISSING` |

The staging ledger itself was not read (the read-only tunnel was down); path (b) reproduces it from fork25's own
migrator and migration set.

Drain set for the repin: of upstream's 91 new migrations, one is `-- deployment-mode: maintenance`
(`0907_subscription_connection_one_owner.sql`); the other 90 and all sixteen fork files (0997-1012) are rolling.

## Regenerated files

| File | How |
| --- | --- |
| `bun.lock` | `bun install` on Bun 1.4.3 (`ee9825191`): only workspace package versions change (upstream's committed lock lagged its release-train manifests); `bun install --frozen-lockfile` then reports no changes |
| `packages/sdk/src/site-browser-runtime.gen.ts` | `bun scripts/generate-site-browser-runtime.ts` (`b6fe4e67f`); `--check` passes |
| `scripts/public-api/surface.gen.json` | `bun scripts/public-api/check.ts --write` (`b6fe4e67f`); adds the fork's routes and SDK methods; `check.ts` passes |
| `packages/contracts/src/app-action-catalog.gen.ts` | `bun scripts/public-api/action-catalog.ts --write` after the exemption above (`414d55809`) |

No other `*.gen.*` file differs from its generator on the merged tree (the fork changed none of the others).

## Verification

Each gate ran once (re-runs only for files a fit touched). Typecheck, lint, format, web build and bundle budget ran at `94c7b2bb7`, before the renumber (`ba4430956`, which oxfmt-reflowed two db tests and renamed one companion test) and the test fits; the migration checks after the renumber; the fork-intent and package suites at `a484934a1`, with `3f1878689` (test-only) re-run alone. Nothing was re-run after `node_modules` was removed (one install, per the brief). "Inherited" means the same command and the
same cases are red on fork25 `a9f495d8f` and/or upstream `01f15f453`, checked the same way on this host; the
evidence is the comparison stated in each row.

| Gate | Result |
| --- | --- |
| `bun install` / `bun install --frozen-lockfile` | PASS (rc 0; frozen: "no changes") |
| `bun run typecheck` | PASS, all 49 projects clean (after `94c7b2bb7`; the bare merge had 7 errors, all fixed there) |
| `bunx oxlint --deny-warnings .` | Inherited-red. 42 findings in 22 files, none from the merge: 13 files are byte-identical to fork25, and the 12 findings in the 9 merged files are the same rule, identifier and file at fork25 (oxlint over fork25's bytes of those 9 files reports exactly them; over upstream's bytes, nothing). Upstream is clean. |
| `bun run format:check` | Inherited-red. 177 files: 87 byte-identical to fork25, 90 merged files that carry fork code, 0 identical to upstream (upstream is clean). Same oxfmt 0.58.0 and `.oxfmtrc.json` at fork25. Not reformatted here, to keep the diff reviewable; a single `oxfmt` commit can follow. |
| `bun run --cwd apps/web build` | PASS |
| `bun run check:web-bundle-budget` | Inherited-red from upstream. Merged: initial raw 1,811,637 B / gzip 474,493 B / 33 files, direct session 3,529,746 / 1,006,546 / 79. Upstream `01f15f453`'s own `apps packages scripts` built the same way on this host: 1,792,802 / 469,052 / 32 and 3,517,151 / 1,000,761 / 78, over the same budgets (1,520,640 / 414,720 / 20; 2,953,216 / 847,872 / 52). The fork adds about 18.8 KB raw and one initial file (its Clerk console auth stays in a lazy chunk). |
| `bun scripts/check-migration-ordinals.ts --base 01f15f453` | No fork collision (0). rc 1 only for upstream's own historical duplicate groups 0730, 0871, 0872, which the checker reports for upstream `01f15f453` itself because the fork's `origin/main`/`origin/production` are an older lineage; fork25 had 11 collisions and 9 duplicate groups. |
| `bun scripts/check-migration-schema-contract.ts` (base `origin/main` and `01f15f453`) | PASS (985 migrations, 683 forward additions) |
| `scripts/release-schema-contract.test.ts` | PASS 28/28 |
| `scripts/embedding-migration-order.test.ts`, `scripts/migration-ordinals.test.ts`, `scripts/check-migration-deployment-mode.test.ts` | PASS 39/39 |
| `bun scripts/public-api/check.ts`, Site runtime `--check` | PASS after regeneration |
| Organization MCP / action catalog tests (`organization-mcp`, `action-schema-imports`, `action-descriptions`, `app-actions`, `surface`) | PASS 74/74 |
| PostgreSQL 17 migration proof | (a) PASS; (b) fork25 database: rc 1, see Migrations |

## Tests

One test file per Bun process (`bun --no-env-file test --timeout=60000 --max-concurrency=1`), the CI's sanitized
environment (`OPENGENI_TEST_HERMETIC=1`, `OPENGENI_REQUIRE_REAL_DB=1`), the repo's own process classes (parallel
files 3 at a time on a host at load 30-40, wall-clock, shared-PostgreSQL and cluster-role files serially), a
20-minute kill per file. Fork-only fixtures supplied: `OPENGENI_TEST_TEMPORAL_ADDRESS` (own dev server), the worker
workflow bundle (`apps/worker/scripts/build-workflow-bundle.ts`), `OPENGENI_EVIDENCE_ASSESSOR_TEST_APP_URL` (an own
migrated PG17 database). Every red file was re-run, with the same environment, on fork25 `a9f495d8f` and on upstream
`01f15f453` (their `apps packages scripts test` checked out into this worktree, their exact migration sets, then
restored; `git status` clean afterwards).

### Fork-intent regressions (Step 5)

The 137 test files that the fork's commits since the merge base add or change
(`git diff --name-only 0355223ee a9f495d8f -- '*test*'`, the renamed `migration-1000` companion included; the
browser e2e `test/e2e/clerk-recovery.browser.e2e.ts` was not run).

| Result | Files |
| --- | --- |
| Green | 122 (3,451 cases passed in the first pass; the fits below and the fork fixtures turn 7 more green) |
| Red only after the merge, fixed by the fits above | 5: `cendra-oauth-profile`, `session-create-observability`, `agent-build-skill-catalog`, `parallel-tool-batch-persistence`, `evidence-assessor-image` (one of its two red cases) |
| Red without the fork fixtures, green with them | 3: `knowledge-file-preparation`, `knowledge-gateways-postgres`, `realtime-voice-billing-postgres` |
| Inherited, same cases red on fork25 | 15: `interaction-frame-proxy` (imports `../src/gateway-realtime`, absent at fork25 too), `evidence-assessor-files` (2 cleanup cases), `evidence-assessor-image` (tenant-rules case), `knowledge-query` (8, stubbed db), `tool-path-phase-timing` (2, source shape), `knowledge-preparation-postgres` (2), `session-realtime-routes` (5 cases answer 502; upstream's new sixth case, an organization ElevenLabs key, fails the same way), `session-create-fresh-outcome` (1), `session-realtime-ledger` (1, `claim.turn.modelContext`), `session-authorization-routes` (1), `context-compaction-activity` (3), `personal-workspace-session-tenancy` (7), `runtime` (3), `tool-approval-upgrade` (1), `migration-0343-...` (1) |

### Conflicted packages' test directories (Step 4)

All `*.test.ts(x)` under `apps/api`, `apps/web`, `apps/worker` and `packages/{contracts,core,db,documents,react,runtime,sdk,testing}`
beyond the 137 above: 3,237 files, 29,451 cases passed, 95 failed, 98 skipped; 55 red files. Classification:

| Class | Files |
| --- | --- |
| Load/collateral, green alone | 3: `session-list-mine-filter`, `billing-usage-recent-postgres` (both `CONNECTION_ENDED` while a cluster-role file reset roles), `session-attach-scoped-sandbox-environment` |
| Red on upstream `01f15f453` too | 7: `native-report-delivery`, `native-spreadsheet-transaction-order` (both need `OPENGENI_ARTIFACT_RUNTIME_MANIFEST`), `migration-0264-...`, `session-control-mega-migration`, `browser-client-surface` (also red on fork25), and `image-generation-credits`, `session-app-actions` (hit the 20-minute kill here; red on upstream as well) |
| Red on fork25 with the same cases, green on upstream (fork divergence that predates this sync) | 38 (39 before fix round 1, which turned `codex-core-usage-attribution` green): `agent-widening-fences`, `connections-routes`, `external-workspace-routing-postgres`, `knowledge-preparation-postgres` (api), `personal-workspace-access`, `published-sites-postgres`, `session-agent-access`, `transcription-routes`, `voice-input-credit-billing`, `cache-notice-replay`, `final-reply-postgres`, `parallel-session-title-finalization`, `scheduled-task-personal-authority`, `session-usage-limit-postgres`, `steer-at-model-step-postgres`, `assistant-message-events` (plus two upstream-new cases of the same kind, below), `agent-session-commands`, `company-brain-context-selection-postgres`, `database-boundary`, `pre-knowledge-memory`, `runtime-posture-compatibility-postgres`, `session-event-writer-audit`, `session-fork-agent-parity-postgres`, `slack-bot-migration-compatibility`, `subscription-personal-acceptance-reads-postgres`, `host-messages`, and the intermediate-ledger migration tests `migration-0152`, `-0199`, `-0345`, `-0393`, `-0461`, `-0552`, `-0716`, `-0717`, `-0733`, `-0737`, `-0763`, `-0764` |
| Merge interaction / fork schema, fixed | 3: `workspace-deletion-cascade-postgres` (its `workspace deletion schema` block failed on the fork's immediate receipt key, "every reference between two removed tables is a deferrable no-action check"; the whole file also hit the 20-minute kill; fixed by 1009/1010, block 2/2 alone), `codex-core-usage-attribution` (title path, 5/5), `model-catalog-scope-postgres` (upstream-new; opted into first-use membership, `3f1878689`; 3/3) |
| Upstream-new tests that meet an existing fork divergence (no fork25 counterpart; same failure mode as fork25's red files) | 3, plus two new cases in `assistant-message-events`: `automation-steer-postgres` (5), `history-footprint-compaction` (2) and those two cases all end in `MODEL_OUTPUT_PRODUCER_INEXACT` at history append, the fork's refusal of model output over history its tests seed without source basis (2026-10-08 finding 4; `final-reply-postgres`, `steer-at-model-step-postgres` and `session-usage-limit-postgres` fail the same way on fork25); `speech-to-text-deployment` (2) reaches the fork's MAINT-P09-430 `recordTranscriptionModelCall` receipt with a stubbed db, the cause of fork25's red `voice-input-credit-billing` and `transcription-routes` |
| Deliberate divergence from this merge | 1: `claude-size-compaction` (1): upstream expects compaction to send its exact withheld wire request; the fork gate re-projects the durable history because the test's withheld items carry no source binding (concern 2) |

No file is red because the merge dropped a fork or upstream behaviour without a recorded decision.

### Fix round 1 re-runs

At `f54969111`, own PG17 and Temporal as above:

| Command | Result |
| --- | --- |
| `bun run typecheck` | PASS, all projects clean |
| `bun scripts/check-migration-schema-contract.ts --base 01f15f453` | PASS (988 migrations, 686 forward additions; 1009-1011 registered) |
| `bun scripts/check-migration-ordinals.ts --base 01f15f453` | no fork collision (only upstream's own 0730/0871/0872 groups, as before) |
| `check-migration-deployment-mode`, `-lock-order`, `-online-safety`, `-rls-backfills` | PASS. Online-safety: constraint-validation exceptions for 0998, 1000 and 1007, whose constraint adds are skipped when the post-image is present, so they do work only on a fresh install. Fix round 1 also gave 1001 an exception on a false premise (it runs again on fork25 databases); fix round 2 removed it, and the guard reports 0 findings without it. |
| `release-schema-contract`, `embedding-migration-order`, `migration-ordinals`, `check-migration-deployment-mode`, `check-migration-online-safety` tests | PASS 111/111 |
| PostgreSQL proof (a)/(b), reruns, dump comparison | PASS (Migrations) |
| `workspace-deletion-cascade-postgres -t "workspace deletion schema"` | PASS 2/2 |
| `existing-external-identity-key-checks` (new) | PASS 2/2; with 1011 removed: 0/2 (`40P01 deadlock detected`, fence still `FOR UPDATE`) |
| 32 test files that touch the changed migrations, functions or usage paths (incl. `usage-event-call-attributes`, `migration-1000-...`, `model-call-source-receipts`, `session-creation-receipt`, `editable-artifact-materialization-postgres`, `external-identity-request-lock-order-postgres`, `membership-fence-foreign-key-checks`, `runtime-posture`, `unified-knowledge-postgres`, `skills-postgres`, `codex-core-usage-attribution`) | 29 green (`usage-event-call-attributes` after `f54969111` reads 1000's check from its new branch); 3 red with exactly the cases they had before (`runtime-posture-compatibility-postgres`, `session-authorization-routes`, `personal-workspace-session-tenancy`, all inherited from fork25) |

### Fix round 2 re-runs

`1001` was rewritten to the post-image rule with its validation moved to the new `1012` (commit "fix(db): make 1001
accept its post-image and validate in 1012"). Own PG17 again:

| Check | Result |
| --- | --- |
| (b) fork25 database (894 rows) -> merged migrator | rc 0, applied 107, 1001 rows; second run applies 0 |
| (a) fresh -> merged migrator | rc 0, applied 989; second run applies 0 |
| (a) vs (b) normalized schema dumps | equal except 0515's install timestamp; call check validated with the COALESCE definition on both |
| 1001 on a database holding its post-image (rolled back) | no `AccessExclusiveLock` on `usage_events` taken |
| 1001 on 1000's definition, then 1012 (rolled back) | rewritten `NOT VALID` with the COALESCE definition, validated by 1012 |
| 1001 on any other definition | `USAGE_EVENT_CALL_ATTRIBUTES_PREIMAGE_DRIFT` |
| `check-migration-online-safety` (no exception header on 1001) | 0 findings |
| `check-migration-schema-contract --base 01f15f453` | ok (989 migrations, 687 forward additions; 1012 registered) |
| deployment-mode, lock-order, rls-backfills, ordinals | PASS / no fork collision |
| Migration script tests | 111/111 |
| `usage-event-call-attributes`, `migration-1000-...`, `runtime-posture` | 140/140 |

Not done (optional): an md5 drift check before 1000's trailing `CREATE OR REPLACE` of
`opengeni_private.enqueue_host_usage_event_export()`. Its body is produced by `format()` with the installed schema
name, so a fixed digest would differ between the public-schema and dedicated-schema deployments. It is still a
complete replacement, so a re-run converges to the same definition.

## New upstream defaults touching auth, tenancy or MCP

Settings are named by their environment variable; "default" is the merged `packages/config` default.

| Area | Upstream change since the base | Default / Cendra impact |
| --- | --- | --- |
| External users (tenancy) | 0923: `external_user:` subjects (Cendra's `asUser` actors) now count as people for the inbox: session owner, else starter, else schedule owner. | On, no setting. Cendra users' questions, approvals and paused goals are recorded as inbox items instead of undelivered; pushes still find no device. |
| External users (auth) | `stampWorkspacePersonAuthorization`: a server-verified external person (a Site's signed viewer, the sender of an accepted chat turn) reloads live access to exactly one workspace, intersected with the caller's cap; a person without a workspace grant reaches only the Personal workspace their active membership names (`externalPersonPersonalWorkspaceId`). No identity is provisioned. | Only reached from those server paths, never from headers or token claims. The fork's existing-only identity resolution and `OPENGENI_EXTERNAL_MEMBER_FIRST_USE_ENABLED=false` are unchanged. |
| Personal workspaces | 0918: per-organization `personal_workspaces_enabled`. | Default true (a missing row means on), the pre-change behaviour. |
| Membership fences | 0925: membership row locks in `ensure_external_identity`, `transition_session_visibility` and both `fork_session_content` overloads become `FOR NO KEY UPDATE`, so foreign-key checks are not blocked. | Fix round 1: the fork's 1005 `read_existing_external_identity` (written before 0925, and with first-use membership off the external identity path on every `asUser` request) is moved to `FOR NO KEY UPDATE` by 1011; `packages/db/test/existing-external-identity-key-checks.test.ts` reproduces upstream's deadlock fixture through it (40P01 without 1011, both commit with it). 1003 already used `FOR KEY SHARE`. |
| App actions | Per-message app-action grants frozen with each turn (0956/0971, `turnAppActionGrant`): only for a human session with context integrity; changes need confirmation for signed-in people. | `OPENGENI_DELEGATED_SIGN_IN_APP_ACTION_CHANGES` default false: a person not signed in through Opengeni's own managed or local session (for example an embedded or delegated human) gets `changes: "none"` app actions. |
| Organization MCP catalog | Many new catalogued app actions (upstream's own routes). | The fork's eight host routes stay exempt (four since 2026-10-08, four added here). |
| OAuth / connections | `exactMcpBinding`/`connectionSelection` removed: reconnect matches the stored MCP URL exactly for every profile; plain connect/add resolve the returned identity atomically. New built-in Google Drive and Google Calendar OAuth profiles. | Drive (`OPENGENI_GOOGLE_DRIVE_MCP_ENABLED`) and Calendar (`OPENGENI_GOOGLE_CALENDAR_ENABLED`) default false; `OPENGENI_GOOGLE_CONNECTOR_SETUP_ENABLED` is new and defaults **true** (Google connector setup offered in the console). |
| Microsoft Teams | Teams bot, Teams tools, Teams conversation proofs on private session create. | `OPENGENI_TEAMS_BOT_ENABLED`, `OPENGENI_MICROSOFT_TEAMS_TOOLS_ENABLED` default false; the proof path only runs when a trusted Teams reference is supplied. |
| Event triggers / MCP Events | Event triggers, event-source feeds and MCP Events subscriptions (0929-0941). | `OPENGENI_EVENT_TRIGGERS_ENABLED` default false. |
| Signup / promotions | Signup challenge; promotion funding decisions with `promotion_enforcement`. | `OPENGENI_SIGNUP_CHALLENGE_ENABLED` default false; `promotion_enforcement.enabled` default false. |
| Billing | Image generation charged in Opengeni credits. | `OPENGENI_IMAGE_GENERATION_OPENGENI_CREDITS_ENABLED` is new and defaults **true**. |
| Workspace governance | Rendered governance becomes a durable developer history item before the turn that first sees it (`ensureSessionWorkspaceGovernance`, 0980 lets message forks carry it). | Written only when governance applies (or must be withdrawn). The rows carry no source basis; the fork's receipt closure accepts them as plain history rows. |
| Observability | Incoming trace context. | `OPENGENI_OBSERVABILITY_TRUST_INCOMING_TRACE_CONTEXT` default false. |

## Open risks and decisions for Native

1. **Renamed migrations (resolved in fix rounds 1 and 2):** all sixteen fork migrations do nothing when their post-image is present; a
   fork25-migrated database upgrades with rc 0 and converges to the fresh schema. The staging ledger was not read.
2. **Compaction exact-request reuse is effectively off for Cendra.** Upstream's withheld-wire-history compaction
   input is used only when every item is bound to a durable history row; otherwise the fork re-projects durable items
   so summaries keep exact `summarySourceIds`. Per `packages/runtime/src/prepared-compaction-request.ts` (55-62) the
   withheld request contains request-local items (tool disclosures, restored tool-search results) that never bind to
   `session_history_items`, so the gate fails whenever lazy tools are present, which is Cendra's normal path. The cost
   is not only the lost prompt-cache read on the compaction request: re-deriving the history diverges from the
   ordinary request, and Claude then drops every later signed thinking block (upstream's own comment).
   `claude-size-compaction` shows the fallback. Native to decide: bind request-local items to their producing call so
   the exact request is attributable, or accept upstream's exact request with a weaker summary provenance.
3. **`subscriptionConnectionId` restored** on terminal model-call settlement and (fix round 1) on session-title usage:
   the fork's replayed helpers (b465f1817) had dropped it on both, so subscription turns at fork25 recorded model and
   title usage without the connection. Upstream's `codex-core-usage-attribution` (red on fork25) is 5/5; an unknown
   connection still falls back through the existing foreign-key path in `model-usage.ts`.
4. **Tool results with a model projection** (upstream's Gmail cards): the fork's source receipt digests the exact tool
   result, while the model sees upstream's projection.
5. **Model calls without fork receipts:** upstream's new meeting-recording transcription and image-generation credit
   paths are not covered by the fork's per-call usage receipts (MAINT-P09-430 covers dictation, model and embedding
   calls).
6. **Organization MCP exemptions:** four more fork host routes exempted (`414d55809`); Native to confirm they should
   stay agent-unreachable.
7. **Fork 1005 lock mode (resolved in fix round 1):** 1011 moves it to `FOR NO KEY UPDATE`.
8. **Workspace deletion (resolved in fix round 1):** the receipt key is deferrable (1009/1010); upstream's
   `workspace deletion schema` block passes 2/2.
9. **Inherited reds:** lint (42 findings) and format (177 files) debt from fork25; web bundle budget red on upstream
   itself; 38 upstream test files already red on fork25 (fork divergence), unchanged here.
10. **Host notes:** dangling `~/.bun/install/cache` symlink (Bun hangs without `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`);
   the shared clone's default credential helper cannot push this fork (pushed with `gh auth git-credential`).
