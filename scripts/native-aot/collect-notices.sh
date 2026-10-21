#!/bin/sh
# Run in the accepted static-musl builder after publish. No runtime downloads.
set -eu
out=$1
mkdir -p "$out/notices"
notices="$out/notices"
nuget="${NUGET_PACKAGES:-/root/.nuget/packages}"
cp /publish/Foxwarm.CliNode "$out/"
cp "$nuget/microsoft.netcore.app.runtime.nativeaot.linux-musl-x64/10.0.12/LICENSE.TXT" "$notices/dotnet-LICENSE.txt"
cp "$nuget/microsoft.netcore.app.runtime.nativeaot.linux-musl-x64/10.0.12/THIRD-PARTY-NOTICES.TXT" "$notices/dotnet-NOTICES.txt"
cp "$nuget/microsoft.aspnetcore.app.runtime.linux-musl-x64/10.0.12/LICENSE.txt" "$notices/aspnetcore-LICENSE.txt"
cp "$nuget/microsoft.aspnetcore.app.runtime.linux-musl-x64/10.0.12/THIRD-PARTY-NOTICES.TXT" "$notices/aspnetcore-NOTICES.txt"
# Record the actual Alpine versions; the accepted image's repositories are mutable.
version() { apk info -v | sed -n "s/^$1-\([0-9].*\)-r[0-9]*$/\1/p"; }
fetch() {
    printf '%s %s\n' "$1" "$2" >> "$notices/SOURCES.txt"
    wget -q -O "$notices/$1" "$2"
    test -s "$notices/$1"
}
fetch PuppeteerSharp-LICENSE.txt https://raw.githubusercontent.com/hardkoded/puppeteer-sharp/7ee221b6b9b4286ccc400bbc2537e4ec9a315dcd/LICENSE
fetch ReactiveExtensionsSharp-LICENSE.txt https://raw.githubusercontent.com/hardkoded/ReactiveExtensions-Sharp/787712268f4bedf5945d43082d450042be275bce/LICENSE
fetch RecyclableMemoryStream-LICENSE.txt https://raw.githubusercontent.com/microsoft/Microsoft.IO.RecyclableMemoryStream/e29a28387da9018fa9605a1dcb3f7a0435aa9974/LICENSE
fetch musl-COPYRIGHT.txt "https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT?h=v$(version musl)"
icu=$(version icu-static | tr . -)
fetch ICU-LICENSE.txt "https://raw.githubusercontent.com/unicode-org/icu/release-$icu/LICENSE"
fetch OpenSSL-LICENSE.txt "https://raw.githubusercontent.com/openssl/openssl/openssl-$(version openssl-libs-static)/LICENSE.txt"
fetch zlib-LICENSE.txt "https://raw.githubusercontent.com/madler/zlib/v$(version zlib-static)/LICENSE"
gcc=$(version gcc)
fetch GCC-COPYING3.txt "https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-$gcc/COPYING3"
fetch GCC-RUNTIME-EXCEPTION.txt "https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-$gcc/COPYING.RUNTIME"
{
    printf 'SDK image input: %s\n' "$SDK_IMAGE"
    printf 'ICU data input: %s\n' "$ICU_DATA_PATH"
    dotnet --info
    apk info -v
    gcc --version
    clang --version
    dotnet list dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj package --include-transitive
    file /publish/Foxwarm.CliNode
    readelf -h -l -d /publish/Foxwarm.CliNode
} > "$out/BUILD-INPUTS.txt"
