# Native CLI redistribution inputs

The package retains Foxwarm's root license and a notice bundle collected from
its actual .NET runtime packs and the corresponding upstream dependency source.
`SOURCES.txt` identifies acquired upstream notice files; `BUILD-INPUTS.txt`
identifies the actual builder packages. This is not a blanket licensing opinion
for other projects, browser installations, or future rebuilds.

| Embedded input | Notice/source basis and redistribution obligation |
| --- | --- |
| .NET Native AOT runtime and ASP.NET Core framework | Their runtime-pack licenses and complete third-party notices are copied from the exact 10.0.14 packages used by publish. These cover runtime-incorporated code including LLVM/libunwind-derived components and other listed dependencies. Keep both license and notice files. |
| Browser host bundle (`browser-host.bundle.cjs`) | A JavaScript bundle of puppeteer-core and its dependencies that runs under the user's installed Node.js; it is not embedded in the executable. The `.LEGAL.txt` file generated with the bundle preserves the bundled projects' license comments and ships beside it. |
| musl | The installed version's complete COPYRIGHT file contains MIT and incorporated-code notices; retain it. |
| ICU and embedded full culture data | The matching ICU release license includes Unicode/data and third-party terms; retain the complete file, not just a generic Unicode license identifier. |
| OpenSSL | The matching release's Apache 2.0 license and copyright notice must accompany copies; preserve any additional applicable upstream attribution. The package does not modify OpenSSL. |
| zlib | Retain the matching source license, including attribution and alteration restrictions. |
| GCC support libraries, including statically linked libgcc/libstdc++ where selected | Include GPLv3 and GCC Runtime Library Exception 3.1. The exception permits eligible target-code combinations produced by an eligible compilation process to be conveyed under independent terms. This ordinary GCC/clang/.NET build does not modify GCC runtime sources or use non-GPL-compatible compiler plugins. The exception is not a general waiver for a modified runtime or an ineligible build; those cases need corresponding-source compliance before distribution. |

The musl, embedded ICU/OpenSSL, zlib and GCC rows apply to the Linux static-musl target. Windows and macOS packages retain the exact .NET/ASP.NET runtime-pack and managed dependency notices; their OS-provided libraries are not redistributed in the package. The macOS PTY dylib/helper are first-party source covered by the root license.

The net10.0 graph prunes Microsoft.Extensions.Logging package references in
favor of the shared framework; its runtime-pack notices remain included. The
builder records the resolved package graph so a new dependency cannot be
silently treated as covered by these rows. Compiler/SDK executables, Node,
Chromium, Git, shells, CA stores and operating-system packages are not bundled.

Before the first distribution of a real rebuild, compare the resolved graph,
actual link inputs and acquired notices with this inventory. Confirm the full
ICU/data attribution and compiler-runtime exception still apply; include any
new required notices or corresponding source. Missing notice inputs fail the
package step. A successful collector or a synthetic packaging test alone does
not establish the legal sufficiency of a newly built binary.
