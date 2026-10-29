---
"@opengeni/react": minor
"@opengeni/contracts": minor
"@opengeni/config": minor
---

Six new optional web console host-extension ports. Each one is validated when it resolves; if a port throws or returns an invalid value, the console falls back and warns once without logging the payload. A console that sets none of them behaves as before.

- `HostExtension.messageContext`: labelled context items attached to typed sends, first-chat creation and realtime starts.
- `HostExtension.starters`: up to eight new-session starters.
- `HostExtension.sessionIndicator`: a persistent component above the session and new-chat views.
- `HostExtension.hiddenNativeSections`: nine closed native section ids, hidden from the rail, settings search, page parts and direct URLs.
- `HostExtension.commandMenuProviders`: abortable search providers whose result paths must be internal.
- `HostExtension.utilities`: up to three lazy rail utilities.

`toolRegistryEntries` can register an exact `mcp_<hex>__<leaf>` card name with `matchPrefixedLeaf: false`.

Contracts: a session authorization target can carry `ownerSubjectId` and `visibility` (`workspace_shared` or `user_private`). The list scope gains `owned` and `owned_or_shared`, both intersected with native visibility, RLS and the viewer. A model call to a tool whose `_meta.ui.visibility` is `["app"]` is refused with JSON-RPC `-32602` and `data.code: "TOOL_NOT_MODEL_VISIBLE"`; the view bridge is unchanged.

Config: `consoleAllowedOrigins` (`OPENGENI_CONSOLE_ALLOWED_ORIGINS`) is an exact-origin CSV that lets a console on another origin sign in with credentials in `legacy` session-set mode. Startup refuses it together with `dual` or `broker`. When it is unset, behaviour is unchanged.
