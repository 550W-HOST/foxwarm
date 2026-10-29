using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class AgentCatalog
{
    internal async Task RemoveIdentityOwnedAsync(
        string name,
        string? preparationName = null,
        JsonObject? previousMetadata = null,
        bool removePublishedDirectory = true
    )
    {
        ValidateName(name);
        if (name == "main")
            throw new InvalidDataException("Identity intent cannot own the Main workspace.");
        await createGate.WaitAsync();
        try
        {
            var directory = SourceDirectory(name);
            if (preparationName is not null)
            {
                var prepared = PreparationPath(preparationName);
                if (Directory.Exists(prepared))
                {
                    if ((File.GetAttributes(prepared) & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidDataException(
                            $"Owned Agent preparation '{prepared}' is a symbolic link; cleanup remains pending."
                        );
                    Directory.Delete(prepared, true);
                }
            }
            if (removePublishedDirectory && Directory.Exists(directory))
            {
                if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException(
                        "Owned Agent directory cannot be a symbolic link."
                    );
                Directory.Delete(directory, true);
            }
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
