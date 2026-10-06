using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed class CompactPlanRepairFile : IAsyncDisposable
{
    private readonly SessionManager sessions;
    private readonly SessionOwner owner;
    private readonly string directory;
    private readonly string filePath;
    private readonly FileStream file;
    private readonly FileIdentity identity;
    private int closed;

    private CompactPlanRepairFile(SessionManager sessions, SessionOwner owner,
        string directory, string filePath, FileStream file, FileIdentity identity, bool structuredFallback)
    {
        this.sessions = sessions; this.owner = owner;
        this.directory = directory; this.filePath = filePath; this.file = file;
        this.identity = identity; StructuredFallback = structuredFallback;
    }

    internal string FilePath => filePath;
    internal bool StructuredFallback { get; }

    internal static async Task<CompactPlanRepairFile> CreateAsync(JsonObject call, SessionManager sessions,
        SessionOwner owner, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var raw = call["rawArgsText"] is JsonValue rawValue && rawValue.TryGetValue<string>(out var rawText) ? rawText : null;
        var structuredFallback = raw is null;
        string content;
        if (raw is not null) content = raw;
        else
        {
            if (call["argsParseError"] is not null || call["args"] is not JsonObject args)
                throw new InvalidDataException("Raw compact arguments are unavailable; submit corrected direct plan fields.");
            content = args.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        }

        var agent = sessions.IdentityWorkspace(owner).ToolDirectory;
        var root = Path.Combine(Path.GetFullPath(agent), ".temp");
        EnsureDirectory(root, 448);
        var directory = Path.Combine(root, "compact-plan-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory); SetMode(directory, 448);
        var filePath = Path.Combine(directory, "plan.json");
        FileStream? file = null;
        try
        {
            file = new FileStream(filePath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 8192, FileOptions.Asynchronous);
            SetMode(filePath, 384);
            var repair = new CompactPlanRepairFile(sessions, owner, directory, filePath, file, Capture(filePath), structuredFallback);
            await repair.AssertOwnedAsync(filePath, token);
            var bytes = StrictUtf8.GetBytes(content);
            await file.WriteAsync(bytes, token); await file.FlushAsync(token);
            await repair.AssertOwnedAsync(filePath, token);
            return repair;
        }
        catch
        {
            if (file is not null) await file.DisposeAsync();
            TryDelete(filePath); TryDelete(directory); throw;
        }
    }

    internal async Task<string> ReadAsync(string requestedPath, CancellationToken token)
    {
        await AssertOwnedAsync(requestedPath, token);
        file.Position = 0;
        using var output = new MemoryStream();
        await file.CopyToAsync(output, token);
        await AssertOwnedAsync(requestedPath, token);
        return StrictUtf8.GetString(output.ToArray());
    }

    internal async Task ApplyAsync(JsonObject call, CancellationToken token)
    {
        var name = SessionWait.Text(call["name"]) ?? throw new InvalidDataException("Repair tool name is missing.");
        var args = call["args"] as JsonObject ?? throw new InvalidDataException("Repair tool arguments must be an object.");
        string target; string updated;
        if (name == "edit")
        {
            if (SessionWait.Text(args["filePath"]) is not string path
                || SessionWait.Text(args["oldText"]) is not string oldText || SessionWait.Text(args["newText"]) is not string newText)
                throw new InvalidDataException("edit requires filePath, oldText and newText strings.");
            target = path;
            await AssertOwnedAsync(target, token);
            var authorized = (JsonObject)args.DeepClone(); authorized["filePath"] = target;
            await sessions.AuthorizeToolAsync(owner, new(name, "node", name, authorized), sessions.IdentityWorkspace(owner), token);
            var current = await ReadAsync(target, token);
            var count = oldText.Length == 0 ? current.Length + 1 : CountOccurrences(current, oldText);
            if (count == 0) throw new InvalidDataException("Could not find oldText in the pending compact repair file.");
            if (count > 1) throw new InvalidDataException($"Found {count} occurrences of oldText in the pending compact repair file.");
            updated = oldText.Length == 0 ? newText : current.Replace(oldText, newText, StringComparison.Ordinal);
        }
        else if (name == "apply_patch")
        {
            if (SessionWait.Text(args["input"]) is not string input) throw new InvalidDataException("apply_patch requires input string.");
            var patches = WorkspacePatch.Parse(input);
            if (patches.Length != 1 || patches[0].Action != "update") throw new InvalidDataException("Repair patches must update only the pending compact repair file.");
            target = patches[0].Path;
            await AssertOwnedAsync(target, token);
            await sessions.AuthorizeToolAsync(owner, new(name, "node", name, (JsonObject)args.DeepClone()), sessions.IdentityWorkspace(owner), token);
            updated = WorkspacePatch.Update(await ReadAsync(target, token), patches[0].Lines, target);
        }
        else throw new InvalidDataException("Only edit or apply_patch may repair compact arguments.");

        await AssertOwnedAsync(target, token);
        file.Position = 0; file.SetLength(0);
        var bytes = StrictUtf8.GetBytes(updated); await file.WriteAsync(bytes, token); await file.FlushAsync(token);
        await AssertOwnedAsync(target, token);
    }

    private async Task AssertOwnedAsync(string requestedPath, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (Volatile.Read(ref closed) != 0 || requestedPath != filePath)
            throw new InvalidDataException("Only the pending repair file for this compact operation may be used.");
        var named = Stat(filePath, false); var held = Stat(file.SafeFileHandle.DangerousGetHandle().ToInt32(), true); var directoryInfo = Stat(directory, false);
        if (!named.Regular || named.Nlink != 1 || named.Uid != identity.Uid || named.Ino != identity.Ino || named.DevMajor != identity.DevMajor || named.DevMinor != identity.DevMinor
            || (named.Mode & 511) != 384 || !held.Regular || held.Uid != identity.Uid || held.Ino != identity.Ino || held.DevMajor != identity.DevMajor || held.DevMinor != identity.DevMinor
            || !directoryInfo.Directory || directoryInfo.Uid != identity.Uid || (directoryInfo.Mode & 511) != 448)
            throw new InvalidDataException("The pending compact repair file was replaced or its permissions changed.");
        await Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref closed, 1) != 0) return;
        await file.DisposeAsync();
        if (Matches(filePath, identity)) TryDelete(filePath);
        TryDelete(directory);
    }

    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static int CountOccurrences(string text, string needle) { var count = 0; for (var index = 0; (index = text.IndexOf(needle, index, StringComparison.Ordinal)) >= 0; index += Math.Max(needle.Length, 1)) count++; return count; }
    private static void EnsureDirectory(string path, int mode)
    {
        if (Directory.Exists(path) && File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("The compact repair directory must not be a symbolic link.");
        var existed = Directory.Exists(path); Directory.CreateDirectory(path);
        if (!existed) SetMode(path, mode);
        if (File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException("The compact repair directory must not be a symbolic link.");
    }
    private static void SetMode(string path, int mode) { if (OperatingSystem.IsLinux()) File.SetUnixFileMode(path, (UnixFileMode)mode); }
    private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); else if (Directory.Exists(path)) Directory.Delete(path); } catch { } }
    private static bool Matches(string path, FileIdentity identity) { try { var current = Stat(path, false); return current.Regular && current.Ino == identity.Ino && current.DevMajor == identity.DevMajor && current.DevMinor == identity.DevMinor; } catch { return false; } }
    private static FileIdentity Capture(string path) => Stat(path, false);

    private sealed record FileIdentity(bool Regular, bool Directory, uint Uid, ulong Ino, uint DevMajor, uint DevMinor, ushort Mode, uint Nlink);
    private static FileIdentity Stat(string path, bool held) => StatCore(held ? "" : path, held ? StatxFlags.EmptyPath : StatxFlags.NoFollow, held ? -1 : -100);
    private static FileIdentity Stat(int fd, bool held) => StatCore("", StatxFlags.EmptyPath, fd);
    private static FileIdentity StatCore(string path, int flags, int dirfd)
    {
        if (!OperatingSystem.IsLinux()) throw new PlatformNotSupportedException("Compact repair files require Linux descriptor identity checks.");
        if (statx(dirfd, path, flags, 0x7ff, out var value) != 0) throw new IOException("Unable to inspect the compact repair file.");
        return new((value.Mode & 0xf000) == 0x8000, (value.Mode & 0xf000) == 0x4000, value.Uid, value.Ino, value.DevMajor, value.DevMinor, value.Mode, value.Nlink);
    }
    private static class StatxFlags { internal const int NoFollow = 0x100; internal const int EmptyPath = 0x1000; }
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)] private static extern int statx(int dirfd, string path, int flags, uint mask, out NativeStatx value);
    [StructLayout(LayoutKind.Sequential)] private struct NativeStatx
    {
        internal uint Mask, Blksize; internal ulong Attributes; internal uint Nlink, Uid, Gid; internal ushort Mode, Spare; internal ulong Ino, Size, Blocks, AttributesMask;
        internal ulong Atime0, Atime1, Btime0, Btime1, Ctime0, Ctime1, Mtime0, Mtime1; internal uint RdevMajor, RdevMinor, DevMajor, DevMinor;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 14)] internal ulong[] Spare2;
    }
}