# Thread: Session communication presentation

## D-session-communication-presentation

[2026-10-17] Conversation displays successful `send_to_session` messages and structured incoming inter-agent messages as readable standalone communication cards in source order. Each card has an explicit To/From direction and peer Session identity, distinct from the current assistant's replies to the user. Already-loaded names improve readability; the exact identifier remains available. Links use the ordinary authorized Session navigation path. No all-Session lookup is introduced.

Tool calls/results remain technical evidence in Activity. A successful outgoing message appears after its owning response, immediately and independently of later assistant prose. Incoming cards strip only their trusted outer transport envelope; authored text and inner quotations are not reclassified as transport. Visible communications close adjacent Activity ranges. Logical-request usage retains one owner; no per-message elapsed time or token estimate is invented. Provider history, source arrays, delivery policy, queues and afterSend behavior remain unchanged.

Current sends record canonical target and body in UI-only function-response metadata; completed ToolScript subcalls use their existing presentation metadata. An in-process delivery callback does not modify tool-visible results. Existing exact-target post-actions support Worker execution. Stored bodies are bounded at 32,768 UTF-16 code units, with an explicit Preview state if full paired call arguments are unavailable. This projection is removed from provider replay with the other function-response display metadata.

Older direct/builtin-dispatched sends require a paired successful response and original call arguments. Failures without actual delivery metadata, unpaired calls, arbitrary stdout, script source and authored success prose do not become sent messages. Historical scripts lacking structured delivery evidence are not reconstructed. Canonical metadata preserves resolved destinations for aliases; unresolved legacy boundary aliases remain non-link labels.

## Owners and checks

- [Session tools](../units/src-tools-session-agent.md) own actual send and optional local delivery notification.
- [Tool executor](../units/src-tool-executor.md) and [ToolScript](../units/src-toolscript.md) persist out-of-band presentation data.
- [Session message rendering](../units/webui-session-messages.md) owns projection, identity and cards.
- [Timeline](../modules/webui-timeline.md) owns display boundaries, Search and request accounting.
- `toolExecutorSessionMessages.test.ts` executes real direct, unified and scripted sends with an isolated data root; the frontend pure/native cases check trusted envelopes, failures, viewport cuts, source order, stable DOM and one visible Search match.
