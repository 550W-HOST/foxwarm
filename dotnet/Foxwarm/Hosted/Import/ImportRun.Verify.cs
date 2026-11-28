using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Hosted.Import;

internal sealed partial class ImportRun
{
    // ---- Verification (plan §9) ----

    private async Task VerifyAsync()
    {
        await report.PhaseAsync("verify Agent files", () => physicalFolders is null ? agentFolders!.VerifyAsync(Hosted.AgentFiles, report, Token) : physicalFolders.VerifyAsync(report, Token), count => count);
        await report.PhaseAsync("verify sessions", VerifySessionsAsync, count => count).ConfigureAwait(false);
        report.Phase("verify catalog", VerifyCatalog, count => count);
        await report.PhaseAsync("verify catalog loads", VerifyCatalogLoadsAsync, count => count).ConfigureAwait(false);
        report.Phase("verify tables", VerifyTables, count => count);
        await report.PhaseAsync("verify journal", VerifyJournalAsync, count => count).ConfigureAwait(false);
        report.Phase("verify documents", VerifyDocuments, count => count);
        await report.PhaseAsync("verify toolscript runs", VerifyToolScriptRunsAsync, count => count).ConfigureAwait(false);
        await report.PhaseAsync("verify secrets", VerifySecretsAsync, count => count).ConfigureAwait(false);
        await report.PhaseAsync("verify blobs", VerifyBlobsAsync, count => count).ConfigureAwait(false);
    }

    // JSON equality per Session document, plus a canonical-JSON SHA-256 of each side.
    private async Task<long> VerifySessionsAsync()
    {
        var sessions = new JsonArray();
        long count = 0;
        long orderDiffers = 0;
        foreach (var (id, path) in source.SessionDocuments())
        {
            Token.ThrowIfCancellationRequested();
            if (!SessionIdentity.IsValid(id))
                continue;
            JsonObject? expected;
            try
            {
                using var stream = File.OpenRead(path);
                expected = JsonNode.Parse(stream) as JsonObject;
            }
            catch (System.Text.Json.JsonException)
            {
                continue;
            }
            if (expected is null)
                continue;
            var stored = await Hosted.Authority.ReadRawAsync(id, Token).ConfigureAwait(false);
            var actual = stored?.Document;
            var sourceHash = ImportJson.Sha256(expected);
            var importedHash = actual is null ? null : ImportJson.Sha256(actual);
            var equal = actual is not null && JsonNode.DeepEquals(expected, actual);
            if (equal && !ImportJson.Same(expected, actual))
                orderDiffers++;
            if (!equal)
                report.Fail($"Session {id}: the imported document isn't JSON-equal to the source" + (actual is null ? " (missing)." : "."));
            sessions.Add(new JsonObject
            {
                ["id"] = id,
                ["records"] = (expected["history"] as JsonArray)?.Count ?? 0,
                ["sha256"] = sourceHash,
                ["importedSha256"] = importedHash,
                ["equal"] = equal,
            });
            count++;
        }
        report.Verification["sessions"] = new JsonObject
        {
            ["count"] = count,
            ["memberOrderDiffers"] = orderDiffers,
            ["documents"] = sessions,
        };
        return count;
    }

    // Every catalog row, copied unchanged: the hosted List equals the file List row for row,
    // so no field an earlier projection wrote is lost; the row hashes are reported.
    private long VerifyCatalog()
    {
        var expected = sourceCatalog?.List() ?? [];
        var actual = Hosted.Catalog.List();
        var hashExpected = Hash(expected);
        var hashActual = Hash(actual);
        var byId = actual.ToDictionary(row => SessionCatalog.Text(row["id"])!, StringComparer.Ordinal);
        long fingerprints = 0;
        foreach (var row in expected)
        {
            var id = SessionCatalog.Text(row["id"])!;
            if (row["meta"]?["waitLivenessFingerprints"] is not null)
                fingerprints++;
            if (!byId.TryGetValue(id, out var imported))
                report.Fail($"Catalog row {id} is missing after import.");
            else if (!JsonNode.DeepEquals(row, imported))
                report.Fail($"Catalog row {id} differs after import.");
        }
        if (actual.Length != expected.Length)
            report.Fail($"The catalog has {actual.Length} rows after import, {expected.Length} in the source.");
        var aliases = VerifyAliases();
        report.Verification["catalog"] = new JsonObject
        {
            ["sourceRows"] = expected.Length,
            ["importedRows"] = actual.Length,
            ["sourceSha256"] = hashExpected,
            ["importedSha256"] = hashActual,
            ["equal"] = hashExpected == hashActual && actual.Length == expected.Length,
            ["rowsWithWaitLivenessFingerprints"] = fingerprints,
            ["aliases"] = aliases,
        };
        if (hashExpected != hashActual)
            report.Fail("The catalog rows' hash differs after import.");
        return expected.Length;
    }

    // Identity aliases are catalog rows too; the hosted table keeps the same columns.
    private JsonObject VerifyAliases()
    {
        if (Copy("catalog.sqlite") is not { } connection)
            return new JsonObject();
        var result = ImportTables.Verify(connection, Db, CatalogAliases);
        if (!result.Equal)
            report.Fail($"session_alias: {result.ImportedRows} rows imported of {result.SourceRows}, or their hashes differ.");
        return new JsonObject
        {
            ["sourceRows"] = result.SourceRows,
            ["importedRows"] = result.ImportedRows,
            ["sourceSha256"] = result.SourceSha256,
            ["importedSha256"] = result.ImportedSha256,
            ["equal"] = result.Equal,
        };
    }

    internal static readonly ImportTable CatalogAliases = new("session_alias", "session_alias", ["alias", "session_id"]);

    private static string Hash(IEnumerable<JsonObject> rows)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var row in rows.OrderBy(row => SessionCatalog.Text(row["id"]), StringComparer.Ordinal))
        {
            hash.AppendData(ImportJson.Canonical(row));
            hash.AppendData("\n"u8);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    // Loads every catalog member the way its owner would: a bound hosted authority with the
    // catalog's Main fields, normalized and admitted like a runtime load.
    private async Task<long> VerifyCatalogLoadsAsync()
    {
        long loaded = 0;
        long absent = 0;
        var failures = new JsonArray();
        var unloadable = new JsonArray();
        foreach (var row in Hosted.Catalog.List())
        {
            Token.ThrowIfCancellationRequested();
            var id = SessionCatalog.Text(row["id"])!;
            var agent = SessionCatalog.Text(row["agent"])!;
            var store = Hosted.Authority.Open(id, agent, new SessionAuthorityCallbacks(MainFields: current => Hosted.Catalog.Get(current)));
            try
            {
                var snapshot = await store.LoadAsync(id, Token).ConfigureAwait(false);
                if (snapshot is null)
                {
                    absent++;
                    if (File.Exists(Path.Combine(source.State, "sessions", id + ".json")))
                    {
                        report.Fail($"Catalog member {id} doesn't load after import.");
                        failures.Add(JsonValue.Create(id));
                    }
                }
                else
                    loaded++;
            }
            catch (Exception error) when (error is not OperationCanceledException and not TenantFencedException)
            {
                // A document file mode can't load either stays unloadable: the import copies
                // it, it doesn't repair it.
                if (await FileLoadErrorAsync(id, agent).ConfigureAwait(false) is { } fileError && fileError == error.Message)
                {
                    unloadable.Add(new JsonObject { ["id"] = id, ["error"] = error.Message });
                    report.Warn($"Catalog member {id} doesn't load in file mode either: {error.Message}");
                }
                else
                {
                    report.Fail($"Catalog member {id} fails to load after import: {error.Message}");
                    failures.Add(JsonValue.Create(id));
                }
            }
            finally
            {
                store.Retire();
            }
        }
        report.Verification["catalogLoads"] = new JsonObject { ["loaded"] = loaded, ["absentInSourceToo"] = absent, ["unloadableInSourceToo"] = unloadable, ["failed"] = failures };
        return loaded;
    }

    // The error a file-mode load of the source document gives, or null when it loads. It
    // loads a copy in the work directory, so nothing a load might write reaches the source.
    private async Task<string?> FileLoadErrorAsync(string id, string agent)
    {
        var root = Path.Combine(work, "load-check", Guid.NewGuid().ToString("N"));
        var target = Path.Combine(root, "state", "sessions", id + ".json");
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Copy(Path.Combine(source.State, "sessions", id + ".json"), target);
        var file = new FileSessionAuthorityBackend(root).Open(
            id,
            agent,
            new SessionAuthorityCallbacks(MainFields: current => sourceCatalog?.Get(current))
        );
        try
        {
            await file.LoadAsync(id, Token).ConfigureAwait(false);
            return null;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return error.Message.Replace(target, Path.Combine(source.State, "sessions", id + ".json"));
        }
        finally
        {
            file.Retire();
        }
    }

    // Row counts and row hashes over the columns both sides have.
    private long VerifyTables()
    {
        var tables = new JsonArray();
        long count = 0;
        void Check(string file, ImportTable table)
        {
            if (Copy(file) is not { } connection)
                return;
            var result = ImportTables.Verify(connection, Db, table);
            tables.Add(new JsonObject
            {
                ["table"] = result.Table,
                ["source"] = $"state/{file} {table.Source}",
                ["sourceRows"] = result.SourceRows,
                ["importedRows"] = result.ImportedRows,
                ["sourceSha256"] = result.SourceSha256,
                ["importedSha256"] = result.ImportedSha256,
                ["equal"] = result.Equal,
            });
            if (!result.Equal)
                report.Fail($"{result.Table}: {result.ImportedRows} rows imported of {result.SourceRows}, or their hashes differ.");
            count += result.SourceRows;
        }
        foreach (var table in new[] { ArchiveMessages, ArchiveBlocks, ArchiveBranches, IdentityReservations, DirectEffects })
            Check("archive-store.sqlite", table);
        Check("tasks.sqlite", Tasks);
        Check("tasks.sqlite", TaskNotes);
        foreach (var table in JournalContent.Append(UsageLedger).Append(RedactionLedger))
            Check("llm-request-journal.sqlite", table);
        foreach (var table in new[] { RedactionMeta, RedactionSlots, RedactionKnown })
            Check("text-redaction.sqlite", table);
        report.Verification["tables"] = tables;
        return count;
    }

    // Every journal request reconstructs to the same request as in file mode (with --journal).
    private async Task<long> VerifyJournalAsync()
    {
        if (!options.Journal || Copy("llm-request-journal.sqlite") is not { } connection || !ImportTables.SourceHas(connection, "llm_journal_requests"))
            return 0;
        var ids = new List<string>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT request_id FROM llm_journal_requests ORDER BY request_id";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                ids.Add(reader.GetString(0));
        }
        // The file journal over a second copy: opening it may run its own schema steps.
        var root = Path.Combine(work, "journal-check");
        Directory.CreateDirectory(Path.Combine(root, "state"));
        File.Copy(Path.Combine(work, "state", "llm-request-journal.sqlite"), Path.Combine(root, "state", "llm-request-journal.sqlite"));
        var file = new LlmRequestJournalStore(root);
        long same = 0;
        long corruptCount = 0;
        try
        {
            var results = new bool[ids.Count];
            var corrupt = new bool[ids.Count];
            await Parallel.ForAsync(
                0,
                ids.Count,
                new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = Token },
                async (index, token) =>
                {
                    var expected = await file.ReconstructAsync(ids[index], token).ConfigureAwait(false);
                    var actual = await Hosted.Journal.ReconstructAsync(ids[index], token).ConfigureAwait(false);
                    corrupt[index] = SessionWait.Text(expected["completeness"]) == "corrupt";
                    results[index] = ImportJson.SameIgnoringOrder(expected, actual);
                }
            ).ConfigureAwait(false);
            for (var index = 0; index < ids.Count; index++)
            {
                if (corrupt[index])
                    corruptCount++;
                if (results[index])
                    same++;
                else
                    report.Fail($"Journal request {ids[index]} reconstructs differently after import.");
            }
        }
        finally
        {
            (file as IDisposable)?.Dispose();
        }
        report.Verification["journalReconstruction"] = new JsonObject { ["requests"] = ids.Count, ["same"] = same, ["corruptInSourceToo"] = corruptCount };
        return ids.Count;
    }

    // Whole documents compare as text, the Node registry and tokens included.
    private long VerifyDocuments()
    {
        var documents = new JsonArray();
        long count = 0;
        var file = new FileStateDocuments(source.Root);
        foreach (var name in new[]
        {
            StateDocumentName.Agents, StateDocumentName.Installation, StateDocumentName.Timers,
            StateDocumentName.Secrets, StateDocumentName.SecretExposures, StateDocumentName.McpOAuth,
            StateDocumentName.Nodes, StateDocumentName.Channels, StateDocumentName.ChannelCursors,
        })
        {
            if (file.Open(name).ReadText() is not { } expected)
                continue;
            var actual = Hosted.Documents.Open(name).ReadText();
            var equal = actual == expected;
            documents.Add(new JsonObject { ["document"] = name.ToString(), ["sha256"] = Sha(expected), ["equal"] = equal });
            if (!equal)
                report.Fail($"State document {name} differs after import.");
            count++;
        }
        var config = Hosted.ConfigDocuments(null);
        foreach (var (name, expected) in new (ConfigDocumentName, byte[]?)[]
        {
            (ConfigDocumentName.Config, this.config is null ? null : System.Text.Encoding.UTF8.GetBytes(this.config.TenantText)),
            (ConfigDocumentName.Models, source.ReadBytes("state/models.yaml")),
            (ConfigDocumentName.ToolAuthorization, source.ReadBytes("state/tool-authorization.yaml")),
            (ConfigDocumentName.Mcp, source.ReadBytes("state/mcp.json") is { } mcp ? AdmitMcpQuiet(mcp) : null),
            (ConfigDocumentName.WebUi, source.ReadBytes("state/webui.json")),
        })
        {
            if (expected is null)
                continue;
            var actual = config.Read(name);
            var equal = actual is not null && actual.AsSpan().SequenceEqual(expected);
            documents.Add(new JsonObject { ["document"] = "config:" + name, ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(expected)), ["equal"] = equal });
            if (!equal)
                report.Fail($"Configuration document {name} differs from what the import installed.");
            count++;
        }
        report.Verification["documents"] = documents;
        return count;
    }

    private byte[] AdmitMcpQuiet(byte[] bytes)
    {
        var dropped = report.Root["configuration"]?["droppedSettings"];
        var copy = dropped?.DeepClone();
        var result = AdmitMcp(bytes);
        if (report.Root["configuration"] is JsonObject section && copy is not null)
            section["droppedSettings"] = copy;
        return result;
    }

    private static string Sha(string text) => Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text)));

    private async Task<long> VerifyToolScriptRunsAsync()
    {
        var file = new Foxwarm.ToolScript.ToolScriptRunStore(source.Root);
        long count = 0;
        foreach (var id in ToolScriptRunIds())
        {
            JsonObject? expected;
            try
            {
                expected = await file.ReadAsync(id, Token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is System.Text.Json.JsonException or InvalidDataException or ArgumentException)
            {
                continue;
            }
            var actual = await Hosted.ToolScriptRuns.ReadAsync(id, Token).ConfigureAwait(false);
            if (!JsonNode.DeepEquals(expected, actual))
                report.Fail($"ToolScript run {id} differs after import.");
            count++;
        }
        report.Verification["toolScriptRuns"] = new JsonObject { ["count"] = count };
        return count;
    }

    // C4: the imported encrypted data opens under the tenant key ring and gives the same
    // values as the file installation under its key file.
    private Task<long> VerifySecretsAsync()
    {
        long count = 0;
        var result = new JsonObject();
        if (!source.Exists("state/secrets.json") && !source.Exists("state/text-redaction.sqlite"))
        {
            report.Verification["secrets"] = result;
            return Task.FromResult(count);
        }
        var sourceRing = new FixedKeyRing(sourceKeys!);
        // The redaction cache is checked on its own below; these read only the secret store.
        using var file = new InstanceSecrets(
            source.Root,
            keyRing: sourceRing,
            documents: new FileStateDocuments(source.Root),
            openTextRedaction: _ => null
        );
        using var hosted = new InstanceSecrets(
            Path.Combine(work, "scratch"),
            keyRing: Hosted.KeyRing,
            documents: Hosted.Documents,
            openTextRedaction: _ => null
        );
        var names = file.Store.List().Where(secret => secret.IsSet).ToList();
        long same = 0;
        foreach (var secret in names)
        {
            var expected = file.Store.Resolve(secret.Name);
            var actual = hosted.Store.Resolve(secret.Name);
            if (expected is null || actual != expected)
                report.Fail($"Secret {secret.Name} doesn't resolve to the source value after import.");
            else
                same++;
            count++;
        }
        result["secrets"] = names.Count;
        result["sameValue"] = same;
        result["keyId"] = Hosted.KeyRing!.OpenOrCreate().KeyId;
        result["sourceKeyId"] = sourceKeys!.KeyId;
        if (result["keyId"]!.GetValue<string>() != sourceKeys.KeyId)
            report.Fail("The tenant data key's ID differs from the installation key's.");
        var slots = VerifyRedactionSlots();
        result["redactionPlaceholders"] = slots;
        count += slots["checked"]!.GetValue<long>();
        report.Verification["secrets"] = result;
        return Task.FromResult(count);
    }

    // The redaction cache's known originals decrypt under the tenant key to the same values
    // and labels as under the installation key. Placeholders are an HMAC of the original under a
    // key derived from the same data key, so each original keeps its placeholder. (Slot records
    // hold only ranges keyed by an HMAC of the slot; their bytes are compared by the row hashes.)
    private JsonObject VerifyRedactionSlots()
    {
        if (Copy("text-redaction.sqlite") is null)
            return new JsonObject { ["checked"] = 0L, ["same"] = 0L };
        var key = sourceKeys!.Derive(InstanceKeys.TextRedactionStorePurpose, 64);
        var tenantKey = Hosted.KeyRing!.OpenOrCreate().Derive(InstanceKeys.TextRedactionStorePurpose, 64);
        if (!CryptographicOperations.FixedTimeEquals(key, tenantKey))
            report.Fail("The tenant's text-redaction key differs from the installation's.");
        var check = Path.Combine(work, "redaction-known", "state", TextRedactionStore.FileName);
        Directory.CreateDirectory(Path.GetDirectoryName(check)!);
        File.Copy(Path.Combine(work, "state", TextRedactionStore.FileName), check, overwrite: true);
        using var sourceStore = TextRedactionStore.Open(check, key, TextRedactor.DefaultKnownBytes);
        using var hostedStore = Hosted.OpenTextRedaction(tenantKey);
        var expected = sourceStore?.ReadKnown() ?? [];
        var actual = hostedStore?.ReadKnown() ?? [];
        long same = 0;
        var restored = actual.Select(item => item.Original + "\0" + string.Join(",", item.Labels)).ToHashSet(StringComparer.Ordinal);
        foreach (var (original, labels) in expected)
            if (restored.Contains(original + "\0" + string.Join(",", labels)))
                same++;
            else
                report.Fail("A known redaction original doesn't decrypt to the source value after import.");
        if (actual.Count != expected.Count)
            report.Fail($"The tenant's redaction cache reads {actual.Count} known originals, the source {expected.Count}.");
        return new JsonObject { ["checked"] = (long)expected.Count, ["same"] = same };
    }

    private async Task<long> VerifyBlobsAsync()
    {
        var images = ImageBlobKeys();
        var artifacts = ArtifactKeys();
        var result = new JsonObject { ["images"] = images.Count, ["artifacts"] = artifacts.Count };
        report.Verification["blobs"] = result;
        if (images.Count + artifacts.Count == 0)
            return 0;
        var (imageStore, artifactStore) = (Hosted.ImageBlobs, Hosted.ArtifactBlobs);
        var sourceImages = new Foxwarm.Images.ImageBlobFiles(source.Root);
        var sourceArtifacts = new Foxwarm.Artifacts.ArtifactBlobFiles(Path.Combine(source.State, "artifacts"));
        long same = 0;
        using var all = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var (keys, from, to) in new[] { (images, (IBlobStore)sourceImages, imageStore), (artifacts, sourceArtifacts, artifactStore) })
            foreach (var key in keys)
            {
                Token.ThrowIfCancellationRequested();
                var expected = SHA256.HashData(await from.ReadAllAsync(key, Token).ConfigureAwait(false));
                byte[]? actual = null;
                try
                {
                    actual = SHA256.HashData(await to.ReadAllAsync(key, Token).ConfigureAwait(false));
                }
                catch (Exception error) when (error is FileNotFoundException or KeyNotFoundException or IOException) { }
                if (actual is not null && CryptographicOperations.FixedTimeEquals(expected, actual))
                    same++;
                else
                    report.Fail($"Blob {key} is missing or differs after import.");
                all.AppendData(System.Text.Encoding.UTF8.GetBytes(key + " "));
                all.AppendData(System.Text.Encoding.UTF8.GetBytes(Convert.ToHexStringLower(expected) + "\n"));
            }
        result["sameHash"] = same;
        result["sha256"] = Convert.ToHexStringLower(all.GetHashAndReset());
        return same;
    }

    /// <summary>A key ring over a key already read (the installation's, which must not be created).</summary>
    private sealed class FixedKeyRing(InstanceKeys keys) : IKeyRing
    {
        public string Locator => keys.FilePath;

        public bool Exists => true;

        public InstanceKeys OpenOrCreate() => keys;
    }
}
