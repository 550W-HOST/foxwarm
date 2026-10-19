# Historical wait-liveness receipts

`wait-liveness-csharp-v1.json` contains synthetic persisted fields emitted by the unchanged C# implementation at `45fc52588a497951a5b074bd967c8eafafad79ec`. They are not expected hashes calculated by the compatibility tests.

For each graph, `dotnet/wait-liveness-fixture-ts.mjs unseen` created the Sessions, initial history and declared wait through Source APIs and strict persistence. The original C# `SessionManager.LoadMainHostAsync` then observed the graph, admitted the real diagnostic through the strict save lane and completed one localhost Responses request. A fresh normal `DeclareWaitAsync` for the same dependencies remained suppressed by that writer. The fixture retains the actual strict-saved wait and fingerprint metadata plus the canonical diagnostic row, using only synthetic names and content.

The idle graph has one existing idle dependency. The cycle graph has two dependencies, declared in reverse lexical order, which wait on each other. The reader tests recreate those graphs through Source, restore these recorded semantic fields, and exercise normal C# startup, strict save, reopen and a genuinely changed dependency graph. They require no second liveness engine, precomputed replacement identity or persisted format version.
