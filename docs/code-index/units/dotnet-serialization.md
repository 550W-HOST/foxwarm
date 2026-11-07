# Unit: Main serialization

Files: `dotnet/Foxwarm/JsonData.cs`, `dotnet/Foxwarm/MainJsonContext.cs`, `dotnet/Foxwarm/FrontMatterYaml.cs`, `dotnet/Foxwarm.Tests/SerializationTests.cs`

## Contracts

Managed and NativeAOT Main use the same JSON construction and metadata paths. Publication mode does not change persisted keys, wire names, null handling or numeric values. Managed publication remains the default.

Dynamic envelopes are JSON DOM values, string-key dictionaries and sequences. `JsonData` converts these without reflecting over arbitrary runtime objects; domain records use the closed `MainJsonContext` metadata set. Add metadata for a new domain record at its actual caller rather than enabling a reflection fallback or retaining entire assemblies. SDK-owned MCP options keep the SDK's resolver.

HTTP and realtime retain their own JSON options, including the existing HTTP image projection converter. HTTP metadata includes `ProblemDetails` for the existing bad-request and error middleware; preserving its 413 mapping is covered by `AsrRoutesTests`. Default storage/model serializers keep their own options. JSON values borrowed from a live record are cloned when inserted into a new DOM parent; serializing an existing root does not clone it. Primitive `JsonArray` additions select the DOM overload rather than the generic serializer overload.

Frontmatter retains YamlDotNet's original untyped scalar, alias, sequence and mapping semantics. `FrontMatterYaml` supplies constructors for its two untyped collection shapes so native code does not need reflection-created collections. It does not substitute the application's configuration YAML conversion rules.

## Primary files

- `dotnet/Foxwarm/JsonData.cs` — dynamic JSON conversion and explicit metadata serialization.
- `dotnet/Foxwarm/MainJsonContext.cs` — first-party DTO and scalar metadata.
- `dotnet/Foxwarm/FrontMatterYaml.cs` — untyped frontmatter collection construction.
- `dotnet/Foxwarm.Tests/SerializationTests.cs` — envelope ownership/value parity, web DTO round trips and original YAML semantic parity.

## Integration references

- [Host runtime](host-runtime.md): HTTP JSON options and startup migration envelopes.
- [Vector owner](vector-owner.md): configuration and result wire DTOs.
- [Vector indexing](vector-indexing.md): row conversion at native table boundaries.
- `packages/webui/test/mainHostFixture.mjs`: disposable managed/native host selection through `coreExecutable` or `FOXWARM_TEST_MAIN_EXECUTABLE`; the same owned data, listener and lifecycle checks apply.

Static analysis warnings are not runtime qualification. Validate the actual serialized paths and their consumers with the owned host harnesses; the metadata set is not a claim that every upstream SDK API supports NativeAOT.
