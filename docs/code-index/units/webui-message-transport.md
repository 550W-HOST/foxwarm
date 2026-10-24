# Unit: WebUI message transport projection

Files: `dotnet/Foxwarm/Channels/WebUi/WebUiMessageTransport.cs`

## Purpose and boundary

`WebUiMessageTransport.Message`, `ProjectMessage`, and `ProjectMessages` project detached canonical messages for WebUI. History and its range modes, continuous Archive pages, exact archived message/JSON reads, History search/window, CTX expansion (both message copies), Debug history/queued messages, WebSocket message/history-append and compatibility SSE use this boundary. Known compact-planner message transcripts use the same projection. The HTTP image converter remains independent; internal tools, Archive records, authority files, request journals and provider replay retain their original values.

Successful function calls follow [D-webui-message-tool-args-transport](./src-channels-webui.md#d-webui-message-tool-args-transport). Projection visits real message parts and known first-party transcript containers, never arbitrary nested call arguments or function-response data. A present `argsParseError`, including null or an empty string in retained input, keeps raw arguments; only an absent property permits trimming.

## D-webui-opaque-thinking-transport

[2026-10-24] WebUI carries the presence and UTF-16 length of recognized opaque reasoning/replay strings instead of their contents. Each length is the original C# `String.Length`, with no byte decoding, token estimate or hash. Empty strings become zero; missing fields stay missing and null stays null. Apply these substitutions only at their known structural positions:

| Canonical field | WebUI field |
| --- | --- |
| `parts[].providerMeta.encryptedThinking` | `encryptedThinkingLength` |
| `parts[].providerMeta.redactedThinking` | `redactedThinkingLength` |
| `parts[].providerMeta.signature` | `signatureLength` |
| `parts[].providerMeta.openaiResponses.outputItem.encrypted_content`, when that item's type is `reasoning` | `encryptedThinkingLength` on that item |
| `providerMeta.providerSpecificFields.reasoning_signature` | `reasoning_signature_length` in those fields |

Visible thinking and summaries, usage, annotations, hosted-tool display metadata, unrelated provider fields and arbitrary nested application values remain available. Complete canonical encrypted/signature/replay data remains available for the next same-model provider request. The browser recognizes encrypted/redacted length presence, including zero, alongside retained legacy string inputs. It never treats these lengths as tokens or visible summary text; existing reasoning cards, badges and usage ownership continue to apply.

This extends ordinary WebUI transport beyond the retained TypeScript behavior. TypeScript's separate History viewer already discarded selected replay-only fields, while its normal Chat message projection only trimmed successful raw tool arguments.

## Tests

`WebUiMessageTransportTests` uses real provider canonical converters and replay serializers, UTF-16 supplementary/combining characters, empty/null/missing values, malformed calls and nested-data negative controls. Its owned HTTP/WS/SSE fixture covers full/ranged history, Debug, continuous and exact Archive reads (including `messageJson`), CTX copies and canonical/Archive preservation. `WebUiMessageTransportVectorTests` uses real local Vector indexing and the authenticated History search route.

`packages/webui/test/experimentHostPayloadStream.e2e.mjs` drives the built original App against an owned normal host and controlled Responses/Anthropic peers: successful and malformed tool cards, encrypted/redacted/signature projection, exact next-request replay, reconnect draft snapshots, fast text versus one-second arguments and final commit ordering. `emptyReasoningHandoff.e2e.mjs` also covers projected and legacy opaque-only inputs, zero-length presence and usage-free badges.
