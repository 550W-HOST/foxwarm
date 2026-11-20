using System.Text.Json.Nodes;

namespace Foxwarm.Code;

// Code URI paths are slash-based. Only a Windows host maps native drive paths; ordinary
// tool/Session paths stay native. Main's local Code services and the Windows CLI Node's fixed
// Code services share this mapping.
internal static class CodeNativePaths
{
    // Windows Code `/` is a synthetic directory of drive roots, not the current drive's root.
    // Native returns this marker for it and only filesystem stat/list may interpret it.
    internal const string VirtualRoot = "/";

    internal static bool IsVirtualRoot(string native) =>
        OperatingSystem.IsWindows() && native == VirtualRoot;

    // `/` or `/C:...`: the Code forms that need conversion on Windows.
    internal static bool IsMapped(string path) =>
        OperatingSystem.IsWindows()
        && (path == VirtualRoot || path.Length >= 3 && path[0] == '/' && IsDrive(path[1], path[2]));

    internal static string Transport(string path)
    {
        if (!OperatingSystem.IsWindows())
            return path;
        var native = Native(path);
        if (IsVirtualRoot(native))
            return VirtualRoot;
        return "/" + char.ToUpperInvariant(native[0]) + native[1..].Replace('\\', '/');
    }

    // Filesystem path. A Windows Code `/` returns VirtualRoot.
    internal static string Native(string path)
    {
        if (!OperatingSystem.IsWindows())
            return path;
        if (path == VirtualRoot)
            return VirtualRoot;
        var value = path;
        if (value.Length >= 3 && value[0] == '/' && IsDrive(value[1], value[2]))
        {
            // Slash-based Code consumers normalize a drive root to /C:.
            // Only this explicitly mapped form denotes a root; native C: is relative.
            value = value[1..];
            if (value.Length == 2)
                value += "/";
        }
        if (
            value.Length < 3
            || !char.IsAsciiLetter(value[0])
            || value[1] != ':'
            || value[2] is not ('/' or '\\')
        )
            throw new CodeServiceException(
                "InvalidPath",
                "Windows Code requires an absolute drive path."
            );
        return Path.GetFullPath(value.Replace('/', '\\'));
    }

    // Process working directory (Git): the synthetic root has no native directory.
    internal static string NativeDirectory(string path)
    {
        var native = Native(path);
        if (IsVirtualRoot(native))
            throw new CodeServiceException(
                "InvalidPath",
                "Windows Code requires an absolute drive path."
            );
        return native;
    }

    // Git results name the repository by native path; Code consumers expect the mapped form.
    internal static void TransportWorkspace(JsonObject value)
    {
        value["workspace"] = Transport(value["workspace"]!.GetValue<string>());
        if (value.ContainsKey("topLevel"))
            value["topLevel"] = Transport(value["topLevel"]!.GetValue<string>());
    }

    private static bool IsDrive(char letter, char colon) => char.IsAsciiLetter(letter) && colon == ':';
}
