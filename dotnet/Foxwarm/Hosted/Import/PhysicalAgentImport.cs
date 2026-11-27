using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Hosted.Import;

/// <summary>A stopped operator installation's physical Agent tree. The staged tree is private to
/// this attempt; publishing it is one rename under the import's tenant and lease locks.</summary>
internal sealed class PhysicalAgentImport(string source, string volume, ImportReport report) : IDisposable
{
    internal const string MissingVolume = "An operator import needs FOXWARM_AGENTS_DIR, the persistent volume path for its Agent folders.";

    private sealed record Entry(string Path, bool Directory, string? Link);
    private readonly List<Entry> entries = [];
    private string? staged;
    private string? destination;
    internal int FileCount => entries.Count(item => !item.Directory && item.Link is null);

    internal static PhysicalAgentImport Scan(string root, bool required, string? volume, string dataRoot, ImportReport report)
    {
        if (string.IsNullOrEmpty(volume))
            throw new ImportRefusedException(MissingVolume);
        var path = AuthorizationPaths.CanonicalPotential(volume);
        foreach (var input in new[] { root, dataRoot })
        {
            var relative = Path.GetRelativePath(AuthorizationPaths.CanonicalPotential(input), path);
            if (!Path.IsPathRooted(relative) && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                throw new ImportRefusedException("FOXWARM_AGENTS_DIR must be outside the installation being imported.");
        }
        var plan = new PhysicalAgentImport(root, path, report);
        var directory = new DirectoryInfo(root);
        if (directory.LinkTarget is not null)
            throw new ImportRefusedException("The Agents directory cannot be a symbolic link.");
        if (directory.Exists)
            plan.ScanDirectory(directory, "", 0);
        else if (required)
            throw new ImportRefusedException("Agents directory not found: " + root);
        return plan;
    }

    private void ScanDirectory(DirectoryInfo directory, string prefix, int depth)
    {
        foreach (var entry in directory.EnumerateFileSystemInfos().OrderBy(item => item.Name, StringComparer.Ordinal))
        {
            var path = prefix + entry.Name;
            if (depth == 1 && entry.Name is "tmp" or ".temp" && (entry is DirectoryInfo || entry.LinkTarget is not null))
                report.NotImported("agents/" + path, 1, "Temporary Agent directory.");
            else if (entry.LinkTarget is { } link)
                entries.Add(new(path, entry is DirectoryInfo, link));
            else if (entry is DirectoryInfo child)
            {
                entries.Add(new(path, true, null));
                ScanDirectory(child, path + "/", depth + 1);
            }
            else if (WorkspaceTools.RegularFile(entry.FullName))
                entries.Add(new(path, false, null));
            else
                report.NotImported("agents/" + path, 1, "Not a regular file.");
        }
    }

    internal void RequireEmptyDestination(int tenantId)
    {
        destination = HostedBootstrap.OperatorAgentsRoot(volume, tenantId);
        if (new DirectoryInfo(destination).LinkTarget is not null || File.Exists(destination)
            || Directory.Exists(destination) && Directory.EnumerateFileSystemEntries(destination).Any())
            throw Conflict();
    }

    private ImportRefusedException Conflict() => new($"The operator Agent directory is not empty: {destination}. Preserve or remove it before importing.");

    internal async Task<long> StageAsync(int tenantId, CancellationToken token)
    {
        RequireEmptyDestination(tenantId);
        Directory.CreateDirectory(volume);
        staged = Path.Combine(volume, ".import-" + tenantId.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-" + Guid.NewGuid().ToString("N"));
        HostedImport.CreatePrivateDirectory(staged);
        foreach (var entry in entries)
        {
            token.ThrowIfCancellationRequested();
            var original = Path.Combine(source, entry.Path);
            var target = Path.Combine(staged, entry.Path);
            if (entry.Link is not null)
            {
                if (entry.Directory) Directory.CreateSymbolicLink(target, entry.Link);
                else File.CreateSymbolicLink(target, entry.Link);
            }
            else if (entry.Directory)
                Directory.CreateDirectory(target);
            else
            {
                await using var input = OpenRegular(original);
                await using var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                await input.CopyToAsync(output, token);
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(target, Permissions(original));
            }
        }
        return FileCount;
    }

    private static FileStream OpenRegular(string path)
    {
        if (new FileInfo(path).LinkTarget is null && WorkspaceTools.RegularFile(path))
        {
            var stream = File.OpenRead(path);
            if (WorkspaceTools.RegularFileHandle(stream, path)) return stream;
            stream.Dispose();
        }
        throw new IOException("The Agent import source changed: " + path);
    }

    [System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
    private static UnixFileMode Permissions(string path) => File.GetUnixFileMode(path) & (UnixFileMode)0x1ff;

    internal async Task<long> VerifyAsync(ImportReport result, CancellationToken token)
    {
        var files = new JsonArray();
        var links = new JsonArray();
        result.Verification["agentFiles"] = files;
        result.Verification["agentLinks"] = links;
        foreach (var entry in entries)
        {
            token.ThrowIfCancellationRequested();
            var original = Path.Combine(source, entry.Path);
            var target = Path.Combine(staged!, entry.Path);
            if (entry.Link is not null)
            {
                if (new FileInfo(target).LinkTarget != entry.Link || new FileInfo(original).LinkTarget != entry.Link)
                    result.Fail("The copied symbolic link differs: " + entry.Path);
                links.Add(new JsonObject { ["path"] = entry.Path, ["target"] = entry.Link });
            }
            else if (!entry.Directory)
            {
                await using var input = OpenRegular(original);
                await using var copy = OpenRegular(target);
                var from = await SHA256.HashDataAsync(input, token);
                var to = await SHA256.HashDataAsync(copy, token);
                var equal = from.AsSpan().SequenceEqual(to) && (OperatingSystem.IsWindows() || Permissions(original) == Permissions(target));
                if (!equal) result.Fail("The copied Agent file differs: " + entry.Path);
                files.Add(new JsonObject { ["path"] = entry.Path, ["sourceSha256"] = Convert.ToHexStringLower(from), ["importedSha256"] = Convert.ToHexStringLower(to), ["equal"] = equal });
            }
        }
        if (!OperatingSystem.IsWindows())
            foreach (var entry in entries.AsEnumerable().Reverse().Where(e => e.Directory && e.Link is null))
                File.SetUnixFileMode(Path.Combine(staged!, entry.Path), Permissions(Path.Combine(source, entry.Path)));
        return FileCount;
    }

    [DllImport("libc", EntryPoint = "rename", SetLastError = true)]
    private static extern int Rename(string oldPath, string newPath);

    [DllImport("libc", EntryPoint = "access", SetLastError = true)]
    private static extern int Access(string path, int mode);

    internal void Publish()
    {
        if (OperatingSystem.IsWindows())
            Directory.Move(staged!, destination!);
        else if (Rename(staged!, destination!) != 0)
        {
            var error = Marshal.GetLastPInvokeError();
            // POSIX refuses a nonempty directory with ENOTEMPTY or EEXIST.
            if (error == 17 || error == (OperatingSystem.IsMacOS() ? 66 : 39)) throw Conflict();
            throw new IOException("Cannot publish the operator Agent directory: " + destination, new Win32Exception(error));
        }
        staged = null;
    }

    internal void ReportPublishedLinks()
    {
        // Check targets at the published paths (including absolute links into the new tree).
        // access(F_OK) also handles cycles and dangling final links without enumerating them.
        var dangling = 0;
        foreach (var link in report.Verification["agentLinks"]!.AsArray())
        {
            var path = Path.Combine(destination!, link!["path"]!.GetValue<string>());
            var exists = OperatingSystem.IsWindows()
                ? File.ResolveLinkTarget(path, returnFinalTarget: true)?.Exists == true
                : Access(path, 0) == 0;
            link["dangling"] = !exists;
            if (!exists) dangling++;
        }
        report.Verification["danglingAgentLinks"] = dangling;
    }

    internal static void RemoveStaging(string volume, int tenantId)
    {
        if (!Directory.Exists(volume)) return;
        var prefix = ".import-" + tenantId.ToString(System.Globalization.CultureInfo.InvariantCulture) + "-";
        foreach (var path in Directory.EnumerateDirectories(volume, prefix + "*"))
            if (Guid.TryParseExact(Path.GetFileName(path)[prefix.Length..], "N", out _))
                RemoveTree(new DirectoryInfo(path));
    }

    // A copied directory may be read-only. Make directories traversable and writable only in
    // this private staging tree; unlink symlinks without walking their targets.
    private static void RemoveTree(DirectoryInfo directory)
    {
        if (directory.LinkTarget is not null) { directory.Delete(); return; }
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        foreach (var item in directory.EnumerateFileSystemInfos())
            if (item is DirectoryInfo child) RemoveTree(child);
            else item.Delete();
        directory.Delete();
    }

    public void Dispose()
    {
        if (staged is not null && Directory.Exists(staged)) RemoveTree(new DirectoryInfo(staged));
    }
}
