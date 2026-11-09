# Unit: Main serialization

Files: `dotnet/Foxwarm/JsonData.cs`, `dotnet/Foxwarm/MainJsonContext.cs`, `dotnet/Foxwarm/FrontMatterYaml.cs`, `dotnet/Foxwarm.Tests/SerializationTests.cs`, `scripts/test/native-main-warnings.baseline`

## Contracts

Managed and NativeAOT Main use the same JSON construction and metadata paths. Publication mode does not change persisted keys, wire names, null handling or numeric values. Managed publication remains the default.

Dynamic envelopes are JSON DOM values, string-key dictionaries and sequences. `JsonData` converts these without reflecting over arbitrary runtime objects; domain records use the closed `MainJsonContext` metadata set. Add metadata for a new domain record at its actual caller rather than enabling a reflection fallback or retaining entire assemblies. SDK-owned MCP options keep the SDK's resolver.

HTTP and realtime retain their own JSON options, including the existing HTTP image projection converter. HTTP metadata includes `ProblemDetails` for the existing bad-request and error middleware; preserving its 413 mapping is covered by `AsrRoutesTests`. Default storage/model serializers keep their own options. JSON values borrowed from a live record are cloned when inserted into a new DOM parent; serializing an existing root does not clone it. Primitive `JsonArray` additions select the DOM overload (`Add((JsonNode?)value)`) rather than the generic serializer overload: `JsonArray.Add<string>` and other non-node `Add<T>` calls build a `JsonValue` through reflection metadata and throw under NativeAOT, even though managed Main accepts them. `Add<T>` with a `JsonNode`-derived argument and `Results.Json` / `WriteAsJsonAsync` of DOM values are runtime-safe because every Main ASP.NET host resolves HTTP JSON through `MainJsonContext`.

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
- `packages/webui/test/mainHostFixture.mjs`: disposable managed/native host selection through `coreExecutable` or `FOXWARM_TEST_MAIN_EXECUTABLE`; the same owned data, listener and lifecycle checks apply. Drivers that spawn their own host use its `mainHostLaunch`, and the full-application harness honours the same variable.
- `npm run test:native` ([test runner](test-runner.md)): the bounded CI smoke against one NativeAOT publication.

## Warning gate

`scripts/test/native-main-warnings.mjs` reads the text log of a linux-x64 NativeAOT publish of Main and keys each NativeAOT compiler (ILC) trim/AOT warning by code, source file, caller (compiler-generated ordinals normalized) and called member. Compile-time analyzer duplicates are ignored because they name no caller. First-party keys are maintained `dotnet/Foxwarm*` sources outside generated `obj/` input. The two DOM-safe call shapes above are accepted by rule; every other first-party key must appear in `native-main-warnings.baseline`, a list of calls reviewed as runtime-safe (serializer calls whose options resolve through `MainJsonContext` or the MCP SDK resolver, YamlDotNet builders used with explicit construction, and the image converter's closed generic). A new key fails the CI native lane; fix the caller rather than extending the baseline unless the call is demonstrably safe. Stale entries are reported, not fatal. LanceDB upstream source, framework and package warnings are counted but not gated: they belong to their own owners.

Static analysis warnings are not runtime qualification. Validate the actual serialized paths and their consumers with the owned host harnesses; the metadata set is not a claim that every upstream SDK API supports NativeAOT.
