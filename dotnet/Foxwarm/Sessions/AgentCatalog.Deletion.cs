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
        RequireNoCreatorChildren(name);
        if (!DirectoryExists(name))
            throw new InvalidDataException($"Agent \"{name}\" not found.");
    }

    internal async Task RemoveDeletedAsync(
        string name,
        bool retainMetadata,
        Func<string, string, Task>? beforeStage
    )
    {
        await createGate.WaitAsync();
        try
        {
            RequireNoCreatorChildren(name);
            if (beforeStage is not null)
                await beforeStage(name, "directory");
            if (store is not null && name == "main")
            {
                // main is always a member, so its root stays: its files go, as its folder's do,
                // and its surviving Sessions can still write memory. Startup fills an empty
                // memory directory with the templates, as for a missing folder.
                foreach (var entry in store.List("main", ""))
                    await store.DeleteAsync("main", entry.Name, recursive: true, null, CancellationToken.None);
            }
            else if (store is not null)
                await store.DeleteAgentAsync(name, CancellationToken.None);
            else
                Directory.Delete(SourceDirectory(name), recursive: true);
            // Canonical command deletion retains the metadata map verbatim. The
            // retained envelope additionally needs its directory membership removed.
            if (retainMetadata && canonicalLayout)
                return;
            var next = MetadataSnapshot();
            var removedMetadata = !retainMetadata && next.Remove(name);
            if (canonicalLayout && !removedMetadata)
                return;
            if (beforeStage is not null)
                await beforeStage(name, "metadata");
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
                AtomicIndexWrite(Payload(names, next).ToJsonText());
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

    internal async Task RemoveRetainedAsync(string name)
    {
        ValidateName(name);
        await createGate.WaitAsync();
        try
        {
            if (DirectoryExists(name))
                throw new InvalidDataException(
                    "Retained-record cleanup requires an absent Agent directory."
                );
            RequireNoCreatorChildren(name);
            var next = MetadataSnapshot();
            if (!next.Remove(name))
                throw new InvalidDataException("No retained Agent metadata exists for this name.");
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
                AtomicIndexWrite(Payload(List().Where(id => id is not "main" && id != name), next).ToJsonText()
                );
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
