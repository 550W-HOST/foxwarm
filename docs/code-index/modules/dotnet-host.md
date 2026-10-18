# Module: Host and ingress

Process startup, environment/configuration capture, HTTP authentication, route composition, message routing, skills, and ASR.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

## Units

- [Core delivery resources and public one-shot CLI](../units/core-delivery-cli.md)
- [Host startup, configuration, and HTTP ingress](../units/host-runtime.md)
- [Shared access identities and scoped WebUI](../units/dotnet-access-identities.md)
- [Message routing and presentation commands](../units/message-routing.md)
- [Shared external channels and managed adapters](../units/dotnet-external-channels.md)
- [Matrix, Weixin and QR login](../units/dotnet-matrix-weixin.md)
- [Speech proxy](../units/asr.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
