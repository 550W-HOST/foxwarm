using Foxwarm.Sessions;

namespace Foxwarm.Vector;

internal sealed partial class VectorLexicalRuntime
{
    private static void RemoveFamily(string path)
    {
        foreach (var file in new[] { path, path + "-wal", path + "-shm" })
            File.Delete(file);
    }

    private static void RemoveSidecars(string path)
    {
        File.Delete(path + "-wal");
        File.Delete(path + "-shm");
    }

    private void SyncDirectory() =>
        LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(databasePath)!);

    private void Reconcile(ArchiveSearchIndex current)
    {
        foreach (var stored in current.SessionIds())
        {
            var canonical = Archive(stored).CanonicalSessionId;
            if (stored == canonical)
                continue;
            try
            {
                if (current.Rename(stored, canonical) != "conflict")
                    continue;
                current.Delete(stored);
                current.Reset(canonical);
                Error("LEXICAL_RECONCILE_CONFLICT");
            }
            catch
            {
                try
                {
                    current.Delete(stored);
                    current.Reset(canonical);
                }
                catch { }
                Error("LEXICAL_RECONCILE_FAILED");
            }
        }
    }

    private void ApplyResets(ArchiveSearchIndex current)
    {
        lock (lane)
        {
            foreach (var id in resets)
            {
                current.Delete(id);
                established.GetValueOrDefault(id)?.TrySetResult();
            }
            foreach (var id in resets.ToArray())
                if (Archive(id).HasReadOnlyIdentity())
                {
                    resets.Remove(id);
                    established.Remove(id);
                }
        }
    }

    private void Prune(ArchiveSearchIndex current)
    {
        foreach (var id in current.SessionIds())
            if (!Archive(id).HasReadOnlyIdentity())
                current.Delete(id);
    }

    private async Task ShadowCatchupAsync(ArchiveSearchIndex current)
    {
        while (!stopping)
        {
            lock (lane)
                ApplyResets(current);
            foreach (var entry in Archive("main").LocalVectorMaxima())
            {
                if (stopping)
                    break;
                await Enqueue(() => IndexAsync(entry.SessionId, allowUnavailable: true));
                lock (lane)
                    ApplyResets(current);
                await YieldAsync();
            }
            if (stopping)
                return;
            lock (lane)
            {
                ApplyResets(current);
                Prune(current);
                if (
                    Archive("main")
                        .LocalVectorMaxima()
                        .All(entry =>
                        {
                            var checkpoint = current.Checkpoint(entry.SessionId);
                            return checkpoint.RawLastIndexedSeq >= entry.MessageSeq
                                && checkpoint.LastIndexedBlockId >= entry.BlockId;
                        })
                )
                    return;
            }
        }
    }

    private async Task ShadowRebuildAsync()
    {
        rebuilding = true;
        backfilling = true;
        ready = false;
        var nextPath = databasePath + ".next";
        var backupPath = databasePath + ".bak";
        try
        {
            var measuredSize = new[] { databasePath, nextPath, backupPath }
                .Select(path => File.Exists(path) ? new FileInfo(path).Length : 0)
                .Max();
            var free =
                FreeBytes?.Invoke()
                ?? new DriveInfo(Path.GetDirectoryName(databasePath)!).AvailableFreeSpace;
            if (free < measuredSize + 64L * 1024 * 1024)
            {
                Error("LEXICAL_REBUILD_SPACE");
                return;
            }
            ArchiveSearchIndex next;
            try
            {
                next = ArchiveSearchIndex.Open(nextPath);
            }
            catch (Exception error) when (Rebuildable(error))
            {
                RemoveFamily(nextPath);
                next = ArchiveSearchIndex.Open(nextPath);
            }
            lock (lane)
            {
                index = next;
                generation = next.Generation;
            }
            await ShadowCatchupAsync(next);
            lock (lane)
            {
                next.Dispose();
                index = null;
            }
            if (stopping)
                return;
            using (var pending = ArchiveSearchIndex.Open(nextPath))
            {
                lock (lane)
                {
                    ApplyResets(pending);
                    Prune(pending);
                }
            }
            using (var validated = ArchiveSearchIndex.Open(nextPath))
                generation = validated.Generation;
            if (File.Exists(databasePath))
            {
                RemoveFamily(backupPath);
                RemoveSidecars(databasePath);
                File.Move(databasePath, backupPath);
            }
            File.Move(nextPath, databasePath);
            SyncDirectory();
            ArchiveSearchIndex? promoted = null;
            try
            {
                BeforePromotionValidation?.Invoke();
                promoted = ArchiveSearchIndex.Open(databasePath);
                lastError = null;
                lastErrorAt = null;
                lock (lane)
                {
                    Reconcile(promoted);
                    ApplyResets(promoted);
                    Prune(promoted);
                }
            }
            catch
            {
                promoted?.Dispose();
                RemoveFamily(nextPath);
                if (File.Exists(databasePath))
                    File.Move(databasePath, nextPath);
                if (File.Exists(backupPath))
                    File.Move(backupPath, databasePath);
                SyncDirectory();
                Error("LEXICAL_REBUILD_PROMOTION_FAILED");
                try
                {
                    using var resumable = ArchiveSearchIndex.Open(nextPath);
                    lock (lane)
                    {
                        ApplyResets(resumable);
                        Prune(resumable);
                    }
                }
                catch { }
                return;
            }
            lock (lane)
            {
                index = promoted;
                generation = promoted.Generation;
            }
            await ShadowCatchupAsync(promoted);
            lock (lane)
            {
                ApplyResets(promoted);
                Prune(promoted);
                ready = true;
            }
            lock (lane)
            {
                foreach (var pending in established.Values)
                    pending.TrySetResult();
                resets.Clear();
                established.Clear();
            }
            try
            {
                RemoveFamily(backupPath);
                RemoveFamily(nextPath);
            }
            catch
            {
                Error("LEXICAL_REBUILD_CLEANUP_FAILED");
            }
            await StartupBackfillAsync();
        }
        catch
        {
            Error("LEXICAL_REBUILD_FAILED");
        }
        finally
        {
            rebuilding = false;
            backfilling = false;
            if (!ready)
                lock (lane)
                    foreach (var pending in established.Values)
                        pending.TrySetResult();
        }
    }

    private Task OpenOrRecoverAsync()
    {
        var next = databasePath + ".next";
        var backup = databasePath + ".bak";
        if (!File.Exists(databasePath) && File.Exists(next))
        {
            startup = ShadowRebuildAsync();
            return Task.CompletedTask;
        }
        if (!File.Exists(databasePath) && File.Exists(backup) && !File.Exists(next))
        {
            File.Move(backup, databasePath);
            SyncDirectory();
        }
        try
        {
            lock (lane)
            {
                index = ArchiveSearchIndex.Open(databasePath);
                lastError = null;
                lastErrorAt = null;
                Reconcile(index);
                generation = index.Generation;
                ready = true;
            }
            RemoveFamily(next);
            RemoveFamily(backup);
        }
        catch (Exception error)
        {
            if (!Rebuildable(error) && File.Exists(databasePath))
                throw;
            Error("ARCHIVE_SEARCH_REBUILD_REQUIRED");
            startup = ShadowRebuildAsync();
        }
        return Task.CompletedTask;
    }

    private void ResetPersisted(params string[] ids)
    {
        if (!config.LexicalIndex)
            return;
        foreach (var path in new[] { databasePath, databasePath + ".next", databasePath + ".bak" })
        {
            if (!File.Exists(path))
                continue;
            try
            {
                using var current = ArchiveSearchIndex.Open(path);
                foreach (var id in ids.Distinct(StringComparer.Ordinal))
                    current.Delete(id);
            }
            catch (Exception error)
            {
                if (Rebuildable(error))
                {
                    try
                    {
                        RemoveFamily(path);
                    }
                    catch
                    {
                        Error("LEXICAL_PREINIT_RESET_REMOVE_FAILED");
                    }
                }
                else
                    Error("LEXICAL_PREINIT_RESET_FAILED");
            }
        }
    }

    private async Task LifecycleAsync(Action<ArchiveSearchIndex> run)
    {
        if (!ready || index is null || rebuilding || stopping)
        {
            Error("LEXICAL_LIFECYCLE_UNAVAILABLE");
            return;
        }
        try
        {
            await Enqueue(() =>
            {
                lock (lane)
                    if (ready && index is not null)
                        run(index);
                return Task.CompletedTask;
            });
        }
        catch
        {
            ready = false;
            Error("LEXICAL_LIFECYCLE_FAILED");
        }
    }

    internal async Task RenameAsync(string oldId, string newId)
    {
        if (!config.LexicalIndex)
            return;
        if (index is null)
        {
            ResetPersisted(oldId, newId);
            return;
        }
        lock (lane)
            foreach (var id in new[] { oldId, newId })
                if (states.TryGetValue(id, out var state))
                    Cancel(state);
        var needsBackfill = false;
        await LifecycleAsync(current =>
        {
            try
            {
                BeforeLifecycleMutation?.Invoke();
                if (current.Rename(oldId, newId) == "conflict")
                {
                    current.Delete(oldId);
                    current.Reset(newId);
                    needsBackfill = true;
                    Error("LEXICAL_RENAME_CONFLICT");
                }
            }
            catch
            {
                try
                {
                    current.Delete(oldId);
                    current.Reset(newId);
                }
                catch { }
                needsBackfill = true;
                Error("LEXICAL_RENAME_FAILED");
            }
        });
        lock (lane)
            if (states.Remove(oldId, out var state) && !states.ContainsKey(newId))
                states[newId] = state;
        if (needsBackfill || ready)
        {
            var stats = Archive(newId).LocalVectorStats();
            Force(newId, stats.MaxSeq, stats.MaxBlockId);
        }
    }

    internal async Task ResetAsync(string id)
    {
        if (!config.LexicalIndex)
            return;
        lock (lane)
            if (states.TryGetValue(id, out var state))
                Cancel(state);
        if (rebuilding)
        {
            TaskCompletionSource pending;
            lock (lane)
            {
                resets.Add(id);
                if (!established.TryGetValue(id, out pending!))
                    established[id] = pending = new(
                        TaskCreationOptions.RunContinuationsAsynchronously
                    );
            }
            if (index is not null)
                try
                {
                    await Enqueue(() =>
                    {
                        lock (lane)
                            if (index is not null)
                            {
                                index.Delete(id);
                                pending.TrySetResult();
                            }
                        return Task.CompletedTask;
                    });
                }
                catch
                {
                    Error("LEXICAL_RESET_FAILED");
                    pending.TrySetResult();
                }
            await pending.Task;
            return;
        }
        if (index is null)
        {
            ResetPersisted(id);
            return;
        }
        await LifecycleAsync(current =>
        {
            try
            {
                current.Delete(id);
            }
            catch
            {
                ready = false;
                Error("LEXICAL_RESET_FAILED");
            }
        });
        lock (lane)
            states.Remove(id);
    }

    internal async Task ForkAsync(string id)
    {
        if (!config.LexicalIndex)
            return;
        lock (lane)
            if (states.TryGetValue(id, out var state))
                Cancel(state);
        var valid = false;
        try
        {
            var branch = Archive(id).ReadBranch();
            valid =
                branch?.ParentSessionId is not null
                && branch.SessionId == Archive(id).CanonicalSessionId;
            await LifecycleAsync(current =>
            {
                try
                {
                    BeforeLifecycleMutation?.Invoke();
                    if (!valid || branch is null)
                    {
                        current.Delete(id);
                        Error("LEXICAL_FORK_INVALID");
                        return;
                    }
                    current.Reset(id, branch.MessageCap, branch.BlockCap);
                }
                catch
                {
                    try
                    {
                        current.Delete(id);
                    }
                    catch { }
                    valid = false;
                    Error("LEXICAL_FORK_FAILED");
                }
            });
        }
        catch
        {
            await LifecycleAsync(current =>
            {
                try
                {
                    current.Delete(id);
                }
                catch { }
            });
            Error("LEXICAL_FORK_FAILED");
        }
        lock (lane)
            states.Remove(id);
        if (valid)
        {
            var stats = Archive(id).LocalVectorStats();
            Force(id, stats.MaxSeq, stats.MaxBlockId);
        }
    }
}
