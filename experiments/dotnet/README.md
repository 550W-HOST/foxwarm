# Experimental .NET prototype

This directory is a manual migration experiment and is not part of the Node.js build or test dependency graph. It currently contains a conventional .NET 10 solution with a behavior-equivalent port of the pure conditional-memory helpers.

## Run

From this directory, with a .NET 10 SDK installed:

```sh
dotnet test Foxwarm.DotnetSpike.sln
```

The prototype intentionally uses ordinary managed .NET targets. It does not enable Native AOT, trimming, browser/WASI targets, or additional workloads.

## Scope and oracle

`Foxwarm.ConditionalMemory` ports `filterConditionalMemorySource`, `buildCurrentModelSnapshot`, and `readCurrentModelSnapshotId` from `src/conditionalMemory.ts`. Its tests are based on the existing TypeScript unit-test corpus and independently assert expected strings; the C# implementation does not generate its own expected values. Coverage includes Unicode, literal regex characters, wildcard identity matching, Foxwarm attribute entities, escaped header identity, inline and fenced examples, malformed/unsupported/orphaned/unclosed/nested markup, exact LF/CRLF bytes, and trailing-newline behavior.

The TypeScript implementation and tests remain authoritative. This experiment is not required by existing Node CI and does not change TypeScript runtime behavior, persistence, model routing, or snapshot ownership.
