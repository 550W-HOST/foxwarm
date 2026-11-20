# LanceDB managed binding

This assembly builds the C# SDK from `lennylxx/lancedb-csharp`, version 2.5.0, commit
`44bc124616d479b8afce2568d1592d95c27d2e92`, under the Apache License 2.0.
The distributed `LanceDB-LICENSE.txt` contains that license.

Foxwarm modifies the managed binding's JSON serialization for the operations used
by its Vector store: storage options, query parameters, merge keys, field metadata,
version information and optimization statistics use generated metadata. The source
patch is maintained in `dotnet/Foxwarm.LanceDb/serialization.patch`.

The upstream managed source is acquired at build time and compiled for .NET 10.
Ordinary builds use the native libraries of the original LanceDB 2.5.0 NuGet package
unchanged. Release packages ship a native library built from the same upstream commit
(`pinvoke/`, Apache License 2.0) with the build configuration in
`dotnet/Foxwarm.LanceDb/native-build.patch`: the `aws`, `azure`, `gcs`, `oss`, `dynamodb`
and `huggingface` features of the `lancedb` dependency are not enabled, and the release
profile optimizes for size. No source code is modified. Packages that include it carry
`LanceDB-native-crates.txt`, which lists the Rust crates linked into the library with their
declared licenses and includes their license texts. Apache.Arrow remains pinned to 22.1.0. This consumer-local assembly is not a general
replacement NuGet package for the upstream SDK's other target frameworks or APIs.
