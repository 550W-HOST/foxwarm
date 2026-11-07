# Unit: Source-built LanceDB binding

Files: `dotnet/Foxwarm.LanceDb/Foxwarm.LanceDb.csproj`, `dotnet/Foxwarm.LanceDb/source.json`, `dotnet/Foxwarm.LanceDb/serialization.patch`, `dotnet/Foxwarm.LanceDb/THIRD-PARTY-NOTICES.md`, `dotnet/scripts/acquire-lancedb-source.py`

## Design decision

Main's managed and native publications use one consumer-local source-built C# binding, pinned to upstream LanceDB C# 2.5.0 commit `44bc124616d479b8afce2568d1592d95c27d2e92`. A repository-local metadata patch covers the JSON operations used by Main. The original LanceDB 2.5.0 package supplies its native runtime assets; Apache.Arrow stays at 22.1.0. This avoids a separate public fork/package and keeps the native engine and Arrow interchange unchanged. Upstream source is generated build input, not checked-in vendored source. (2026-11-07.)

## Primary files

- `dotnet/Foxwarm.LanceDb/Foxwarm.LanceDb.csproj` — net10.0 binding compilation and notice delivery.
- `dotnet/Foxwarm.LanceDb/source.json` — upstream commit, archive identity and consumer-verified download digest.
- `dotnet/Foxwarm.LanceDb/serialization.patch` — focused generated JSON metadata and caller changes.
- `dotnet/Foxwarm.LanceDb/THIRD-PARTY-NOTICES.md` — upstream license and modification notice.
- `dotnet/scripts/acquire-lancedb-source.py` — acquire, verify and patch the generated source beneath the project output directory.

## Build boundary

The acquisition step requires Python and Git and downloads the pinned archive on a clean build. It reuses the verified local archive on subsequent builds. The generated `src` files and license stay under `obj/upstream`; the compiled assembly has the consumer-local identity `Foxwarm.LanceDb` while retaining the upstream API namespace.

`dotnet/Foxwarm/Foxwarm.csproj` excludes the package's managed compile and runtime assets with `ExcludeAssets="compile;runtime"`. It references the source-build project and retains the original package's RID-native assets. Normal managed and AOT builds therefore resolve the same binding implementation.

The patch covers storage options, query parameters, merge keys, field metadata, versions and optimization statistics used by the [Vector table owner](vector-indexing.md). Unused upstream APIs retain their original implementation and are not a claim of complete upstream NativeAOT support. Upgrade the pinned source, patch and native package together; inspect the resolved compile, runtime and publish assets when changing this boundary.

## Integration references

- [Vector owner](vector-owner.md): local versus child placement and lifecycle.
- [Main serialization](dotnet-serialization.md): first-party row and wire metadata.
- `dotnet/Foxwarm.Tests/scripts/qualify-vector-startup.mjs`: actual owned Main startup, corruption survival, model/tool exchange and restart in both placements.
