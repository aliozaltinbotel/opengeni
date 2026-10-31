---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
---

A governing host can withhold the provider's reasoning from the organizations it governs: set `reasoningDisclosure: "withheld"` on `OrganizationGovernancePort`. Every `agent.reasoning.delta` of such an organization's sessions is then delivered at its sequence without text (only a numeric `coalescedUntil` stays) on the session event stream (live, replay and the bounded batch), the session event list in every mode, forensic included, and the MCP `session_events` debug and compact reads, so cursors and gap detection are unchanged and the stock transcript draws no thinking row. A forensic page that withheld text answers `X-OpenGeni-Forensic-Exact: false`. A worker given the same port (`organizationGovernance` in its activity dependencies) asks the provider for no reasoning summary for those turns (`reasoningSummary: "none"` in the runtime's agent options). Stored events and model history are not changed. Unset or `"full"`, nothing changes. New exports: `REASONING_DISCLOSURES` and `ReasoningDisclosure` from `@opengeni/contracts/organization-governance`, and `organizationReasoningDisclosure` and `withholdSessionEventReasoning` from `@opengeni/core`.
