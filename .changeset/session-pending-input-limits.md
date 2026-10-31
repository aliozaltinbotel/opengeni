---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

A session's pending input (Send and Steer messages accepted but not yet started) is now bounded. `SESSION_PENDING_INPUT_LIMITS` (`maxCount` 64, `maxBytes` 4 MiB of message text plus model context, `ttlMs` seven days) is the default; deployments set `OPENGENI_SESSION_PENDING_INPUT_MAX_COUNT`, `OPENGENI_SESSION_PENDING_INPUT_MAX_BYTES` and `OPENGENI_SESSION_PENDING_INPUT_TTL_MS`. A Send or Steer through the API or the first-party MCP past the count or bytes answers 429 `limit_exceeded` with `details.code: "SESSION_PENDING_INPUT_LIMIT_REACHED"`, the bound, the pending count and bytes and `retryAfterSeconds` (also `Retry-After`), and writes nothing; a message larger than `maxBytes` on its own is refused as not retryable. A pending message older than `ttlMs` stops counting and is retired at the session's next admission like a deleted prompt: its turn is cancelled with `cancelReason: "pending_input_expired"` and a `session.queue.changed` delete event names that reason; its `user.message` stays in the history. Lifecycle admissions that pass no bounds are unchanged. New exports: `SESSION_PENDING_INPUT_LIMITS`, `SessionPendingInputLimits`, `SESSION_PENDING_INPUT_LIMIT_REACHED` and `SESSION_PENDING_INPUT_EXPIRED` from `@opengeni/contracts`, `SessionPendingInputLimitError`, `retireExpiredPendingInputInTransaction` and `assertSessionPendingInputWithinLimitsInTransaction` from `@opengeni/db`, and `sessionPendingInputLimits` from `@opengeni/core`.
