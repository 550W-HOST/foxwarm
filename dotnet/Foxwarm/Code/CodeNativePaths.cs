namespace Foxwarm.Code;

// Code URI paths are slash-based. Only the Windows Main boundary maps a native
// drive path; ordinary tool/Session paths and remote service payloads stay native.
internal static class CodeNativePaths
{
    internal static string Transport(string path)
    {
        if (!OperatingSystem.IsWindows())
            return path;
        var native = Native(path);
        return "/" + char.ToUpperInvariant(native[0]) + native[1..].Replace('\\', '/');
    }

    internal static string Native(string path)
    {
        if (!OperatingSystem.IsWindows())
            return path;
        var value = path;
        if (value.Length >= 3 && value[0] == '/' && char.IsAsciiLetter(value[1]) && value[2] == ':')
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
}
