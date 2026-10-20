# Module: Host and ingress

Process startup, environment/configuration capture, HTTP authentication, route composition, message routing, skills, and ASR.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

## Units

- [Managed source Main entry](../units/source-main-entry.md)
- [Core delivery resources and public one-shot CLI](../units/core-delivery-cli.md)
- [Host startup, configuration, and HTTP ingress](../units/host-runtime.md)
- [Shared access identities and scoped WebUI](../units/dotnet-access-identities.md)
- [Message routing and presentation commands](../units/message-routing.md)
- [Public command administration](../units/dotnet-command-administration.md)
- [Shared external channels and managed adapters](../units/dotnet-external-channels.md)
- [Matrix, Weixin and QR login](../units/dotnet-matrix-weixin.md)
- [WeWork callback, WebSocket, streams and media](../units/dotnet-wework.md)
- [Speech proxy](../units/asr.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
