# Native CLI redistribution inputs

The package retains Foxwarm's root license and a notice bundle collected from
its actual .NET runtime packs and the corresponding upstream dependency source.
`SOURCES.txt` identifies acquired upstream notice files; `BUILD-INPUTS.txt`
identifies the actual builder packages. This is not a blanket licensing opinion
for other projects, browser installations, or future rebuilds.

| Embedded input | Notice/source basis and redistribution obligation |
| --- | --- |
| .NET Native AOT runtime and ASP.NET Core framework | Their runtime-pack licenses and complete third-party notices are copied from the exact 10.0.12 packages used by publish. These cover runtime-incorporated code including LLVM/libunwind-derived components and other listed dependencies. Keep both license and notice files. |
| PuppeteerSharp.Cdp 25.14.0 | MIT license from repository commit `7ee221b6b9b4286ccc400bbc2537e4ec9a315dcd`, the commit recorded in its NuGet metadata. Keep copyright and permission notice. |
| ReactiveExtensionsSharp 0.3.0 | MIT license from NuGet's repository commit `787712268f4bedf5945d43082d450042be275bce`. Keep copyright and permission notice. |
| Microsoft.IO.RecyclableMemoryStream 3.0.1 | MIT license from NuGet's repository commit `e29a28387da9018fa9605a1dcb3f7a0435aa9974`. Keep copyright and permission notice. |
| musl | The installed version's complete COPYRIGHT file contains MIT and incorporated-code notices; retain it. |
| ICU and embedded full culture data | The matching ICU release license includes Unicode/data and third-party terms; retain the complete file, not just a generic Unicode license identifier. |
| OpenSSL | The matching release's Apache 2.0 license and copyright notice must accompany copies; preserve any additional applicable upstream attribution. The package does not modify OpenSSL. |
| zlib | Retain the matching source license, including attribution and alteration restrictions. |
| GCC support libraries, including statically linked libgcc/libstdc++ where selected | Include GPLv3 and GCC Runtime Library Exception 3.1. The exception permits eligible target-code combinations produced by an eligible compilation process to be conveyed under independent terms. This ordinary GCC/clang/.NET build does not modify GCC runtime sources or use non-GPL-compatible compiler plugins. The exception is not a general waiver for a modified runtime or an ineligible build; those cases need corresponding-source compliance before distribution. |

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
