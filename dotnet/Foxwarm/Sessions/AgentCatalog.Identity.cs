using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class AgentCatalog
{
    internal const string IdentityProofFileName = ".identity-owner";

    private static FileAttributes? IdentityEntry(string path)
    {
        try
        {
            return File.GetAttributes(path);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
    }

    private static bool IdentityProofMatches(string directory, string? proof)
    {
        if (proof is null)
            return false;
        try
        {
            var marker = Path.Combine(directory, IdentityProofFileName);
            var attributes = IdentityEntry(marker);
            return attributes is not null
                && (attributes.Value & (FileAttributes.Directory | FileAttributes.ReparsePoint))
                    == 0
                && new FileInfo(marker).Length == proof.Length
                && string.Equals(File.ReadAllText(marker), proof, StringComparison.Ordinal);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static void WriteIdentityProof(string directory, string proof)
    {
        using (
            var file = new FileStream(
                Path.Combine(directory, IdentityProofFileName),
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None
            )
        )
        {
            file.Write(System.Text.Encoding.UTF8.GetBytes(proof));
            file.Flush(flushToDisk: true);
        }
        LinuxAtomicJsonFile.LinuxDirectorySync.Sync(directory);
    }

    private string[] IdentityCleanupDirectories(string name, string? preparationName)
    {
        var paths = preparationName is null
            ? new[] { SourceDirectory(name) }
            : new[] { PreparationPath(preparationName), SourceDirectory(name) };
        var present = new List<string>();
        var unverified = new List<string>();
        foreach (var path in paths)
        {
            var attributes = IdentityEntry(path);
            if (attributes is null)
                continue;
            if (
                (attributes.Value & FileAttributes.Directory) == 0
                || (attributes.Value & FileAttributes.ReparsePoint) != 0
                || !IdentityProofMatches(path, preparationName)
            )
                unverified.Add(path);
            else
                present.Add(path);
        }
        if (unverified.Count > 0)
            throw new AgentIdentityCleanupException(unverified.ToArray());
        return present.ToArray();
    }

    internal void ValidateIdentityOwnedPaths(string name, string? preparationName) =>
        _ = IdentityCleanupDirectories(name, preparationName);

    internal async Task RemoveIdentityOwnedAsync(
        string name,
        string? preparationName = null,
        JsonObject? previousMetadata = null
    )
    {
        ValidateName(name);
        if (name == "main")
            throw new InvalidDataException("Identity intent cannot own the Main workspace.");
        await createGate.WaitAsync();
        try
        {
            foreach (var path in IdentityCleanupDirectories(name, preparationName))
                Directory.Delete(path, true);
            if (Exists(name) || MetadataSnapshot().ContainsKey(name))
            {
                var next = MetadataSnapshot();
                if (previousMetadata is null)
                    next.Remove(name);
                else
                    next[name] = previousMetadata.DeepClone();
                void Publish()
                {
                    lock (stateGate)
                    {
                        known.Remove(name);
                        metadata = next;
                    }
                }
                try
                {
                    AtomicIndexWrite(
                        indexPath,
                        Payload(List().Where(id => id is not "main" && id != name), next)
                            .ToJsonString()
                    );
                }
                catch (AuthorityCommittedException)
                {
                    Publish();
                    throw;
                }
                Publish();
            }
        }
        finally
        {
            createGate.Release();
        }
    }

    internal async Task CompleteIdentityOwnedAsync(string name, string? preparationName)
    {
        if (preparationName is null)
            return; // Old finishing intents have no proof to remove and authorize no directory deletion.
        await createGate.WaitAsync();
        try
        {
            var prepared = PreparationPath(preparationName);
            if (IdentityEntry(prepared) is not null)
                throw new AgentIdentityCleanupException([prepared]);
            var directory = SourceDirectory(name);
            var attributes = IdentityEntry(directory);
            if (
                attributes is null
                || (attributes.Value & FileAttributes.Directory) == 0
                || (attributes.Value & FileAttributes.ReparsePoint) != 0
            )
                throw new AgentIdentityCleanupException([directory]);
            var marker = Path.Combine(directory, IdentityProofFileName);
            if (IdentityEntry(marker) is null)
                return; // Alias commit makes proof removal idempotent; no directory is deleted here.
            if (!IdentityProofMatches(directory, preparationName))
                throw new AgentIdentityCleanupException([marker]);
            File.Delete(marker);
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(directory);
        }
        finally
        {
            createGate.Release();
        }
    }

    internal void CopyIdentityMemory(string sourceAgent, string targetAgent)
    {
        var source = Path.Combine(SourceDirectory(sourceAgent), "memory");
        // Main's memory owner is independent of its tool workspace.
        if (sourceAgent == "main")
            source = MemoryDirectory(sourceAgent);
        var target = MemoryDirectory(targetAgent);
        if (!Directory.Exists(source))
            return;
        static void Copy(DirectoryInfo source, string target)
        {
            Directory.CreateDirectory(target);
            foreach (var item in source.EnumerateFileSystemInfos())
            {
                var destination = Path.Combine(target, item.Name);
                if (item.LinkTarget is { } link)
                {
                    if (item is DirectoryInfo)
                        Directory.CreateSymbolicLink(destination, link);
                    else
                        File.CreateSymbolicLink(destination, link);
                }
                else if (item is DirectoryInfo directory)
                    Copy(directory, destination);
                else
                    File.Copy(item.FullName, destination, true);
            }
        }
        Copy(new DirectoryInfo(source), target);
    }
}

internal sealed class AgentIdentityCleanupException(string[] paths)
    : IOException(
        "Agent identity cleanup requires manual intervention. Unverified paths: "
            + string.Join(", ", paths.Select(path => "'" + path + "'"))
    )
{
    internal string[] Paths { get; } = paths;
}
