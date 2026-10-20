# Unit: Speech proxy

Files: `dotnet/Foxwarm/Asr/AsrProxy.Stream.cs`, `dotnet/Foxwarm/Asr/AsrProxy.cs`

## Purpose

Forwards authenticated browser WebSocket traffic to the configured ASR backend. HTTP transcription remains an independent multipart caller.

## Stable symbols and callers

`AsrProxy.StreamAsync` owns one browser/upstream pair. It forwards ordered text and binary fragments without parsing ASR messages, stripping fields, enforcing start/ready/audio/stop phases, or closing after a final transcript. The actual service and browser own those meanings. There is no recording, ready, finalization, cumulative audio, control or transcript deadline/budget in this proxy. The separate HTTP transcription caller retains its existing ten-minute timeout and audio/metadata/output admission.

Browser upgrade follows normal host authentication. Only configured upstream Authorization is sent; browser Cookie and Origin are not copied. Browser messages received during upstream connection are queued in order, and browser closure cancels the pending handshake. Service closure carries its close status/reason to the browser; browser closure, transport failure, request abort and host stopping release both sockets and observe both pumps. Per-socket send serialization and the bounded close handshake are managed WebSocket mechanics, not ASR protocol policy.

Callers and adjacent boundaries: WebUIChannel setup/audio routes.

## Tests

`AsrRoutesTests` and partial fixtures use the real host routes and loopback peers: ordinary fragmented PCM/start/ready/partial/stop/final, opaque non-JSON and binary extensions, traffic beyond the removed audio/output caps, continued traffic after final, configured headers, authentication, rejection/redirect, peer closure, cancellation during connection and a delayed final beyond the former cutoff. HTTP transcription coverage remains separate. `experimentHostAsr.e2e.mjs` exercises the built original App and fake microphone PCM through an owned TLS-prefix proxy and scripted service; it does not qualify model inference.
