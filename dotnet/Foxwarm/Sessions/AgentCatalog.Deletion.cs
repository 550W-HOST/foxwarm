namespace Foxwarm.Sessions;

internal sealed partial class AgentCatalog
{
    internal void ValidateDeletion(string name, bool command)
    {
        ValidateName(name);
        if (name == "main")
        {
            if (!command)
                throw new InvalidDataException("The main agent cannot be deleted.");
            if (!canonicalLayout)
                throw new InvalidDataException(
                    "Cannot delete the main Agent in this retained workspace layout because its folder is shared. No Sessions or files were deleted."
                );
        }
        if (!Directory.Exists(SourceDirectory(name)))
            throw new InvalidDataException($"Agent \"{name}\" not found.");
    }

    internal async Task RemoveDeletedAsync(string name, bool retainMetadata, Func<string, string, Task>? beforeStage)
    {
        await createGate.WaitAsync();
        try
        {
            if (beforeStage is not null)
                await beforeStage(name, "directory");
            Directory.Delete(SourceDirectory(name), recursive: true);
            // Canonical command deletion retains the metadata map verbatim. The
            // retained envelope additionally needs its directory membership removed.
            if (retainMetadata && canonicalLayout)
                return;
            if (beforeStage is not null)
                await beforeStage(name, "metadata");
            var next = MetadataSnapshot();
            if (!retainMetadata)
                next.Remove(name);
            var names = List().Where(id => id != "main" && id != name).ToArray();
            void Publish()
            {
                lock (stateGate)
                {
                    if (name != "main")
                        known.Remove(name);
                    metadata = next;
                }
            }
            try
            {
                AtomicIndexWrite(indexPath, Payload(names, next).ToJsonString());
            }
            catch (AuthorityCommittedException)
            {
                Publish();
                throw;
            }
            Publish();
        }
        finally
        {
            createGate.Release();
        }
    }
}
