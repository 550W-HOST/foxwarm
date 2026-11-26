# Module: Host and ingress

Process startup, environment/configuration capture, HTTP authentication, route composition, message routing, skills, and ASR.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

## Units

- [Managed source Main entry](../units/source-main-entry.md)
- [Core delivery resources and public one-shot CLI](../units/core-delivery-cli.md)
- [Release packages, installers and package controls](../units/release-packages.md)
- [Desktop packages, installer and qualification](../units/desktop-packages.md)
- [Host startup, configuration, and HTTP ingress](../units/host-runtime.md)
- [Installation lock](../units/installation-lock.md): one Main process per data directory.
- [Hosted database access, schema and fencing](../units/hosted-database.md): the hosted build switch, the transaction helper, migrations and the tenant write fence.
- [Skill resolution and runnable skills](../units/skills.md)
- [Packed and loose HTTP resources](../units/http-assets.md)
- [Windows Desktop host](../units/desktop-windows.md)
- [macOS Desktop host](../units/desktop-macos.md)
- [Desktop instances](../units/desktop-instances.md)
- [Main JSON and frontmatter serialization](../units/dotnet-serialization.md)
- [Shared access identities and scoped WebUI](../units/dotnet-access-identities.md)
- [Secret store, references and redaction](../units/dotnet-secrets.md)
- [Message routing and presentation commands](../units/message-routing.md)
- [Public command administration](../units/dotnet-command-administration.md)
- [Shared external channels and managed adapters](../units/dotnet-external-channels.md)
- [Matrix, Weixin and QR login](../units/dotnet-matrix-weixin.md)
- [WeWork callback, WebSocket, streams and media](../units/dotnet-wework.md)
- [Speech proxy](../units/asr.md)
- [Multica bridge CLI](../units/multica-bridge-cli.md)
- [Repository quality scripts](../units/quality-scripts.md)
- [Code Index generators](../units/code-index-generators.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
