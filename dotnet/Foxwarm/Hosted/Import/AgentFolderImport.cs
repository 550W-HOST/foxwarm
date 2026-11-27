using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Hosted.Import;

/// <summary>The Agent directories of a stopped installation or an offline Agents volume.</summary>
internal sealed class AgentFolderImport
{
    private sealed record Entry(string? Agent, string Key, string Source, bool Directory, long Length)
    {
        public string Name => Agent is null ? Key : Key.Length == 0 ? Agent : Agent + "/" + Key;
    }

    private readonly List<Entry> entries = [];
    internal int FileCount => entries.Count(entry => !entry.Directory);

    internal static AgentFolderImport Scan(string root, long fileLimit, ImportReport report, bool required)
    {
        var plan = new AgentFolderImport();
        var directory = new DirectoryInfo(root);
        if (directory.LinkTarget is not null)
            throw new ImportRefusedException("The Agents directory cannot be a symbolic link.");
        if (!directory.Exists)
        {
            if (required)
                throw new ImportRefusedException("Agents directory not found: " + root);
            return plan;
        }
        foreach (var entry in directory.EnumerateFileSystemInfos().OrderBy(item => item.Name, StringComparer.Ordinal))
        {
            if (entry.LinkTarget is not null)
                report.NotImported("agents/" + entry.Name, 1, "Symbolic link.");
            else if (entry is DirectoryInfo agent)
            {
                try { AgentCatalog.ValidateName(agent.Name); }
                catch (InvalidDataException error)
                {
                    report.NotImported("agents/" + agent.Name, 1, error.Message);
                    continue;
                }
                Visit(agent.Name, "", agent);
            }
            else
                Visit(null, entry.Name, entry);
        }
        return plan;

        void Visit(string? agent, string key, FileSystemInfo entry)
        {
            var label = "agents/" + (agent is null ? "" : agent + "/") + key;
            if (entry.LinkTarget is not null)
                report.NotImported(label, 1, "Symbolic link.");
            else if (AgentFilePaths.Problem(key, allowRoot: true) is { } problem)
                report.NotImported(label, 1, "Invalid Agent file path: " + problem + ".");
            else if (entry is DirectoryInfo folder)
            {
                if (key is "tmp" or ".temp")
                {
                    report.NotImported(label, 1, "Temporary Agent directory.");
                    return;
                }
                plan.entries.Add(new(agent, key, entry.FullName, true, 0));
                foreach (var child in folder.EnumerateFileSystemInfos().OrderBy(item => item.Name, StringComparer.Ordinal))
                    Visit(agent, key.Length == 0 ? child.Name : key + "/" + child.Name, child);
            }
            else if (entry is not FileInfo file || !WorkspaceTools.RegularFile(entry.FullName))
                report.NotImported(label, 1, "Not a regular file.");
            else if (!OperatingSystem.IsWindows() && (File.GetUnixFileMode(file.FullName) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0)
                report.NotImported(label, 1, "Executable file.");
            else if (file.Length > fileLimit)
                report.NotImported(label, 1, "Larger than the per-file limit.");
            else
                plan.entries.Add(new(agent, key, file.FullName, false, file.Length));
        }
    }

    internal async Task<long> WriteAsync(IAgentStore store, CancellationToken token)
    {
        foreach (var entry in entries)
        {
            token.ThrowIfCancellationRequested();
            if (entry.Directory && entry.Key.Length == 0)
            {
                if (!store.AgentExists(entry.Agent!))
                    await store.CreateAgentAsync(entry.Agent!, [], [], token, restoration: true);
                continue;
            }
            var existing = store.Stat(entry.Agent, entry.Key);
            if (entry.Directory)
            {
                if (existing is { IsDirectory: false })
                    throw Conflict(entry);
                if (existing is null)
                    await store.MakeDirectoryAsync(entry.Agent, entry.Key, token);
                continue;
            }
            if (existing is { IsDirectory: true } || existing is not null && existing.Length != entry.Length)
                throw Conflict(entry);
            var bytes = await SourceBytesAsync(entry, token);
            if (existing is null)
                await store.WriteAsync(entry.Agent, entry.Key, bytes, 0, token);
            else
            {
                var stored = await store.ReadAsync(entry.Agent, entry.Key, token);
                if (!bytes.AsSpan().SequenceEqual(stored.Bytes))
                    throw Conflict(entry);
            }
        }
        return FileCount;
    }

    private static IOException Conflict(Entry entry) => new("The existing Agent file or directory differs: " + entry.Name + ". Nothing was overwritten.");

    private static async Task<byte[]> SourceBytesAsync(Entry entry, CancellationToken token)
    {
        if (!WorkspaceTools.RegularFile(entry.Source) || new FileInfo(entry.Source).LinkTarget is not null)
            throw new IOException("The Agent import source changed: " + entry.Name);
        await using var stream = File.OpenRead(entry.Source);
        if (!WorkspaceTools.RegularFileHandle(stream, entry.Source) || stream.Length != entry.Length)
            throw new IOException("The Agent import source changed: " + entry.Name);
        var bytes = new byte[checked((int)entry.Length)];
        await stream.ReadExactlyAsync(bytes, token);
        return bytes;
    }

    internal async Task<long> VerifyAsync(IAgentStore store, ImportReport report, CancellationToken token)
    {
        var verified = new JsonArray();
        report.Verification["agentFiles"] = verified;
        foreach (var entry in entries)
        {
            token.ThrowIfCancellationRequested();
            if (entry.Directory)
            {
                if (store.Stat(entry.Agent, entry.Key) is not { IsDirectory: true })
                    report.Fail("Missing Agent directory: " + entry.Name);
                continue;
            }
            var source = SHA256.HashData(await SourceBytesAsync(entry, token));
            var stored = SHA256.HashData((await store.ReadAsync(entry.Agent, entry.Key, token)).Bytes);
            var equal = source.AsSpan().SequenceEqual(stored);
            verified.Add(new JsonObject { ["path"] = entry.Name, ["sourceSha256"] = Convert.ToHexStringLower(source), ["importedSha256"] = Convert.ToHexStringLower(stored), ["equal"] = equal });
            if (!equal)
                report.Fail("The imported Agent file differs from its source: " + entry.Name);
        }
        return verified.Count;
    }
}
