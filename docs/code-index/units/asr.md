# Unit: Speech proxy

Files: `dotnet/Foxwarm/Asr/AsrProxy.Stream.cs`, `dotnet/Foxwarm/Asr/AsrProxy.cs`

## Purpose

Forwards authenticated browser WebSocket traffic to the configured ASR backend. HTTP transcription remains an independent multipart caller.

## Stable symbols and callers

`AsrProxy.StreamAsync` owns one browser/upstream pair. It forwards ordered text and binary fragments without parsing ASR messages, stripping fields, enforcing start/ready/audio/stop phases, or closing after a final transcript. The actual service and browser own those meanings. There is no recording, ready, finalization, cumulative audio, control or transcript deadline/budget in this proxy. The separate HTTP transcription caller retains its existing ten-minute timeout and audio/metadata/output admission.

Each receive owner retains Source `ws`'s inclusive 100 MiB per-message transport admission, counting bytes across receives and resetting only at end-of-message. An over-limit message fails the existing pair lifetime before its completing fragment is forwarded; earlier streamed fragments may already be observable as an incomplete prefix and are not rolled back. Source's ASR handlers relay only complete `ws` message events. This preserves complete-message admission without buffering or rewriting the relay; it is not a cumulative recording limit.

Browser upgrade follows normal host authentication. Only configured upstream Authorization is sent; browser Cookie and Origin are not copied. Browser messages received during upstream connection are queued in order, and browser closure cancels the pending handshake. Service closure carries its close status/reason to the browser; browser closure, transport failure, request abort and host stopping release both sockets and observe both pumps. Per-socket send serialization and the bounded close handshake are managed WebSocket mechanics, not ASR protocol policy.

Callers and adjacent boundaries: WebUIChannel setup/audio routes.

## Tests

`AsrRoutesTests` and partial fixtures use the real host routes and loopback peers: ordinary fragmented PCM/start/ready/partial/stop/final, opaque non-JSON and binary extensions, traffic beyond the removed audio/output caps, continued traffic after final, configured headers, authentication, rejection/redirect, peer closure, cancellation during connection and a delayed final beyond the former cutoff. `AsrRoutesTests.MessageBoundary.cs` covers both directions at 100 MiB minus one, exactly 100 MiB and plus one, single/fragmented messages, an empty final fragment, multiple valid messages exceeding 100 MiB in aggregate, and ordered traffic queued before connection. HTTP transcription coverage remains separate. `mainHostAsr.e2e.mjs` qualifies the built App with its Composer recording controller and required AbortSignal, using fake microphone PCM through an owned TLS-prefix proxy and scripted service; it does not qualify model inference.
