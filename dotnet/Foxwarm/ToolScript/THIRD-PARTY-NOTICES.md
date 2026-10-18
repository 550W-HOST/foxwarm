# ToolScript native protocol dependencies

The native ToolScript engine is the official Pydantic Monty 0.0.19 standalone
Linux x64 GNU or Windows x64 MSVC `monty subprocess` executable. Builds acquire
the exact official `@pydantic/monty-linux-x64-gnu` or
`@pydantic/monty-win32-x64-msvc` 0.0.19 package for the target RID and include
only its standalone worker in application output. Native binaries are build
outputs, not tracked repository source.
The protocol schema is from official Monty tag v0.0.19. Its MIT license is
included in `MONTY-LICENSE`.

The .NET protocol binding uses Google.Protobuf 3.35.1 under BSD-3-Clause; see
`PROTOBUF-LICENSE`. Grpc.Tools 2.84.0 supplies the build-time generator under
Apache-2.0; see `GRPC-TOOLS-LICENSE`. Grpc.Tools is not a runtime dependency.
Generated protocol files remain build outputs, not hand-maintained sources.

This binding does not use the Node native addon, CPython, a JavaScript runtime,
or a WASM fallback. Redistribution of a native engine build must retain the
upstream notices applicable to that artifact and its dependencies.
