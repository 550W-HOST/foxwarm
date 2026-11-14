# Third-Party Notices

## `@tencent-weixin/openclaw-weixin` v1.0.2

Portions of Foxwarm's Weixin channel implementation are adapted from
`@tencent-weixin/openclaw-weixin` v1.0.2:

- Package: `@tencent-weixin/openclaw-weixin`
- Version: `1.0.2`
- Published package: <https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin/v/1.0.2>
- Source archive: <https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-1.0.2.tgz>
- License: MIT

MIT License

Copyright (c) 2026 Tencent Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## .NET Vector dependencies

The optional .NET Vector owner uses the community `LanceDB` NuGet package
version 2.5.0 and `Apache.Arrow` version 22.1.0. Both are distributed under
Apache License 2.0. Their license texts are included in .NET publish output as
`LanceDB-LICENSE.txt` and `Apache-Arrow-LICENSE.txt`.

Release packages ship the LanceDB native library built from the SDK's pinned source
without its object-store back ends (build configuration in
`dotnet/Foxwarm.LanceDb/native-build.patch`) and a ToolScript worker built from the
Pydantic Monty v0.0.19 source (MIT License) without its type checker
(`dotnet/Foxwarm/ToolScript/monty-no-type-check.patch`). `LanceDB-native-crates.txt` and
`Monty-native-crates.txt` in those packages list the Rust crates linked into each binary
with their declared licenses and license texts.

- LanceDB C# SDK: <https://github.com/lennylxx/lancedb-csharp>
- Apache Arrow: <https://github.com/apache/arrow>
