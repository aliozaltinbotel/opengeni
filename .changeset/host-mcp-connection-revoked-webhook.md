---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

New optional host webhook `mcp_connection.revoked` (`settings.hostWebhooks.mcpConnectionRevoked`, from `OPENGENI_HOST_WEBHOOK_MCP_CONNECTION_REVOKED_URL` and `OPENGENI_HOST_WEBHOOK_MCP_CONNECTION_REVOKED_SECRET`). When an MCP connection is disconnected, or its access setting loses a permission or a workspace, the API starts one durable delivery through the workflow client's new optional `startHostWebhookDelivery` (the `hostWebhookDeliveryWorkflow` Temporal workflow) right before it writes the change; the worker POSTs `HostMcpConnectionRevokedWebhook` once it sees the change committed, signed `X-Host-Signature: sha256=<hex HMAC-SHA256(secret, body)>` with `X-Host-Delivery: <id>`, and retries the same body and id with backoff until the host answers 2xx. A change that never commits sends nothing. Unset, nothing is started and nothing changes. New exports `HostMcpConnectionRevokedWebhook`, `HostWebhookDeliveryRequest`, `HOST_WEBHOOK_SIGNATURE_HEADER` and `HOST_WEBHOOK_DELIVERY_HEADER` (`@opengeni/contracts/organization-governance`) and `mcpOAuthConnectionConsentScope` (`@opengeni/db`).
