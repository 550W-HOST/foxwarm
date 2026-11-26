using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Hosted.Import;

internal sealed partial class ImportRun
{
    // Tables copied row for row; their hosted tables keep the file store's columns.
    internal static readonly ImportTable ArchiveMessages = new("archive_messages", "archive_messages", ["session_id", "seq"]);
    internal static readonly ImportTable ArchiveBlocks = new("archive_blocks", "archive_blocks", ["session_id", "id"]);
    internal static readonly ImportTable ArchiveBranches = new("archive_branches", "archive_branches", ["session_id"]);
    internal static readonly ImportTable IdentityReservations = new("archive_session_id_reservations", "session_id_reservations", ["session_id"]);
    internal static readonly ImportTable DirectEffects = new("archive_direct_effects", "archive_direct_effects", ["id"], Identity: "id", OverridingSystemValue: true);
    internal static readonly ImportTable Tasks = new("tasks", "tasks", ["id"], ParentColumn: "parentTaskId");
    internal static readonly ImportTable TaskNotes = new("task_notes", "task_notes", ["id"], Identity: "id");
    internal static readonly ImportTable JournalObjects = new("llm_journal_objects", "llm_journal_objects", ["object_id"]);
    internal static readonly ImportTable JournalRequests = new("llm_journal_requests", "llm_journal_requests", ["request_id"], Identity: "seq", Mapped: Rowid);
    internal static readonly ImportTable JournalStarts = new("llm_journal_attempt_starts", "llm_journal_attempt_starts", ["event_id"], Identity: "seq", Mapped: Rowid);
    internal static readonly ImportTable JournalResults = new("llm_journal_attempt_results", "llm_journal_attempt_results", ["event_id"], Identity: "seq", Mapped: Rowid);
    internal static readonly ImportTable JournalLedgerRange = new("llm_journal_metadata", "llm_journal_metadata", ["key"], Where: "key IN ('usage-ledger-low', 'usage-ledger-high')");
    internal static readonly ImportTable UsageLedger = new("llm_usage", "llm_usage", ["request_id", "attempt"]);
    internal static readonly ImportTable RedactionLedger = new("llm_redaction", "llm_redaction", ["request_id", "attempt"]);
    internal static readonly ImportTable RedactionMeta = new("meta", "text_redaction_meta", ["key"]);
    internal static readonly ImportTable RedactionSlots = new("slots", "text_redaction_slots", ["identity", "slot"]);
    internal static readonly ImportTable RedactionKnown = new("known", "text_redaction_known", ["id"]);

    // The journal's identity columns keep the file journal's rowid, which the usage ledger's
    // covered range (usage-ledger-low/high) refers to.
    private static IReadOnlyDictionary<string, string> Rowid => new Dictionary<string, string> { ["seq"] = "rowid" };

    private ImportTable[] JournalContent => options.Journal ? [JournalObjects, JournalRequests, JournalStarts, JournalResults, JournalLedgerRange] : [];

    // State documents imported verbatim, in phase order.
    private static readonly (string Phase, StateDocumentName Name, string File)[] AgentDocuments =
    [
        ("agent metadata", StateDocumentName.Agents, "state/agents.json"),
        ("agent metadata", StateDocumentName.Installation, "state/installation.json"),
    ];

    private Microsoft.Data.Sqlite.SqliteConnection? Copy(string file) => copies.GetValueOrDefault(file);

    // ---- Plan ----

    private JsonObject Plan()
    {
        long Rows(string file, ImportTable table) => Copy(file) is { } connection ? ImportTables.CountRows(connection, table) : 0;
        var documents = source.SessionDocuments().Count();
        var (frontier, other) = source.SessionDirectoryLeftovers();
        var plan = new JsonObject
        {
            ["catalogRows"] = sourceCatalog?.List().Length ?? 0,
            ["sessionDocuments"] = documents,
            ["archiveMessages"] = Rows("archive-store.sqlite", ArchiveMessages),
            ["archiveBlocks"] = Rows("archive-store.sqlite", ArchiveBlocks),
            ["archiveBranches"] = Rows("archive-store.sqlite", ArchiveBranches),
            ["identityReservations"] = Rows("archive-store.sqlite", IdentityReservations),
            ["directEffects"] = Rows("archive-store.sqlite", DirectEffects),
            ["tasks"] = Rows("tasks.sqlite", Tasks),
            ["taskNotes"] = Rows("tasks.sqlite", TaskNotes),
            ["toolScriptRuns"] = ToolScriptRunIds().Count,
            ["usageLedgerRows"] = Rows("llm-request-journal.sqlite", UsageLedger),
            ["redactionLedgerRows"] = Rows("llm-request-journal.sqlite", RedactionLedger),
            ["journalRequests"] = options.Journal ? Rows("llm-request-journal.sqlite", JournalRequests) : 0,
            ["journalObjects"] = options.Journal ? Rows("llm-request-journal.sqlite", JournalObjects) : 0,
            ["redactionSlots"] = Rows("text-redaction.sqlite", RedactionSlots),
            ["redactionKnown"] = Rows("text-redaction.sqlite", RedactionKnown),
            ["imageBlobs"] = ImageBlobKeys().Count,
            ["artifactObjects"] = ArtifactKeys().Count,
        };
        NotImportedInventory(frontier, other);
        return plan;
    }

    // Source data with no hosted owner in P1, each with a line in the report.
    private void NotImportedInventory(int frontier, int other)
    {
        var state = source.State;
        report.NotImported(
            "Agent folders (" + Path.Combine(source.Root, "agents") + ")",
            Directory.Exists(Path.Combine(source.Root, "agents")) ? Directory.GetDirectories(Path.Combine(source.Root, "agents")).Length : 0,
            "Q1: copy them to the FOXWARM_AGENTS_DIR volume before the first replica starts; every Agent the catalog names must exist there."
        );
        if (source.ReadJson("state/running-exec.json") is { } exec)
            report.NotImported(
                "exec registry (state/running-exec.json)",
                (exec["execs"] as JsonArray)?.Count ?? 0,
                "Hosted P1 has no Main-local exec; tracked and recent exec IDs aren't carried over."
            );
        if (Directory.Exists(Path.Combine(state, "db")))
            report.NotImported("Vector data (state/db)", 1, "P3: re-derived from the Archive.");
        if (frontier > 0)
            report.NotImported("legacy frontier files (state/sessions/*.frontier.json)", frontier, "Earlier layouts' artifacts; current Main reads none, and a database never holds them.");
        if (other > 0)
            report.NotImported("other files under state/sessions", other, "Not authority documents.");
        if (Copy("session-runtime.sqlite") is { } runtime)
            report.NotImported(
                "legacy Session Worker store (state/session-runtime.sqlite)",
                ImportTables.CountRows(runtime, new ImportTable("session_worker_mailbox", "", ["rowid"]))
                    + ImportTables.CountRows(runtime, new ImportTable("session_worker_ownership", "", ["rowid"])),
                "The removed Session Worker's evidence that file-mode deletion checks; hosted mode has no owner for it."
            );
        if (Copy("archive-store.sqlite") is { } archive)
        {
            foreach (var (table, reason) in new[]
            {
                ("archive_tool_effects", "The derived activity index; rebuilt from the Archive in P3."),
                ("archive_checkpoints", "Vector indexing checkpoints (P3)."),
                ("archive_import_state", "Legacy JSONL import markers; file mode only."),
            })
                if (ImportTables.SourceHas(archive, table))
                    report.NotImported("state/archive-store.sqlite " + table, ImportTables.CountRows(archive, new ImportTable(table, "", ["rowid"])), reason);
        }
        if (Copy("llm-request-journal.sqlite") is { } journal && !options.Journal)
            report.NotImported(
                "LLM request journal (requests, attempts and objects)",
                ImportTables.CountRows(journal, JournalRequests),
                "Imported only with --journal; the usage and redaction ledgers are imported either way."
            );
        foreach (var (directory, reason) in new[]
        {
            ("sessions-blob", "Legacy per-Session image artifacts of an earlier layout."),
            ("session-workers", "The removed Session Worker's files."),
            ("vscode-web", "Main-local VS Code Web state; hosted tenants have no Main-local Code."),
            (".temp", "Main-local temporary files (terminals)."),
            ("migration-backup", "File-mode migration backups."),
            ("logs", "Main logs; hosted replicas log to stdout."),
            ("provider-image-cache", "A disposable cache, rebuilt per replica."),
            ("agents", "No current Foxwarm code reads it."),
            ("claude-runtime", "Claude Code runtime state; hosted P1 has no Claude runtime."),
            ("runtime-runs", "Claude Code runtime state; hosted P1 has no Claude runtime."),
        })
            if (Directory.Exists(Path.Combine(state, directory)))
                report.NotImported("state/" + directory, Directory.EnumerateFiles(Path.Combine(state, directory), "*", SearchOption.AllDirectories).Count(), reason);
        var known = new HashSet<string>(StringComparer.Ordinal)
        {
            "agents.json", "installation.json", "timers.json", "channels.json", "nodes.json", "mcp-oauth.json",
            "secrets.json", "secret-exposures.json", "config.yaml", "models.yaml", "tool-authorization.yaml",
            "mcp.json", "webui.json", "token", "node_token", "node_event_capability_secret", "running-exec.json",
            "migrationVersion.json", "session-id-reservations.jsonl", "main.lock", InstallationLock.FileName,
        };
        foreach (var file in ImportSource.SqliteFiles)
        {
            known.Add(file);
            known.Add(file + "-wal");
            known.Add(file + "-shm");
        }
        foreach (var path in Directory.EnumerateFiles(state).Order(StringComparer.Ordinal))
        {
            var name = Path.GetFileName(path);
            if (known.Contains(name))
                continue;
            var reason = name switch
            {
                "nodes.json.bak" or _ when name.StartsWith("nodes.json.", StringComparison.Ordinal) => "Node registry backups; the current registry is imported.",
                "desktop-port" => "Desktop only.",
                "migrationVersion.json" => "File-mode migration markers.",
                _ when name.EndsWith(".lock", StringComparison.Ordinal) => "File-mode lock files.",
                _ => "No hosted owner.",
            };
            report.NotImported("state/" + name, 1, reason);
        }
        foreach (var path in Directory.EnumerateDirectories(state).Order(StringComparer.Ordinal))
        {
            var name = Path.GetFileName(path);
            if (name is "sessions" or "image-blobs" or "artifacts" or "toolscript-runs" or "db"
                or "sessions-blob" or "session-workers" or "vscode-web" or ".temp" or "migration-backup" or "logs"
                or "provider-image-cache" or "agents" or "claude-runtime" or "runtime-runs")
                continue;
            report.NotImported("state/" + name, Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories).Count(), "No hosted owner.");
        }
        if (source.ReadJson("state/migrationVersion.json") is not null)
            report.NotImported("file-mode migration markers (state/migrationVersion.json)", 1, "Hosted schema versions are tracked by `foxwarm db migrate`.");
        if (source.ReadText("state/mcp.json") is { } mcp && JsonNode.Parse(mcp)?["servers"] is JsonObject servers)
            foreach (var (name, server) in servers)
                if (SessionWait.Text(server?["transport"]) == "stdio")
                    report.Warn($"MCP server {name} uses the stdio transport, which hosted mode refuses; it is dropped from the tenant's MCP document.");
    }

    // ---- Writes, in dependency order ----

    private async Task WriteAsync()
    {
        await StepAsync("keys", () =>
        {
            HostedKeyRing.Adopt(Db, sourceKeys!, databases.Kek);
            Hosted.KeyRing = new HostedKeyRing(Db, databases.Kek);
            return 1;
        });
        await StepAsync("agent metadata", () => AgentDocuments.Sum(document => CopyDocument(document.Name, document.File)));
        await StepAsync("catalog", ImportCatalog);
        await StepAsync("session documents", ImportSessionDocuments);
        await StepAsync("archive", ImportArchive);
        await StepAsync("identity ledger", () => CopyTable("archive-store.sqlite", IdentityReservations));
        await StepAsync("tasks", () => CopyTable("tasks.sqlite", Tasks) + CopyTable("tasks.sqlite", TaskNotes));
        await StepAsync("timers", () => CopyDocument(StateDocumentName.Timers, "state/timers.json"));
        await StepAsync("toolscript runs", ImportToolScriptRunsAsync);
        await StepAsync("activity direct effects", () => CopyTable("archive-store.sqlite", DirectEffects));
        await StepAsync("journal", ImportJournal);
        await StepAsync("text-redaction cache", () =>
            CopyTable("text-redaction.sqlite", RedactionMeta) + CopyTable("text-redaction.sqlite", RedactionSlots) + CopyTable("text-redaction.sqlite", RedactionKnown));
        await StepAsync("secrets and OAuth grants", () =>
            CopyDocument(StateDocumentName.Secrets, "state/secrets.json")
            + CopyDocument(StateDocumentName.SecretExposures, "state/secret-exposures.json")
            + CopyDocument(StateDocumentName.McpOAuth, "state/mcp-oauth.json"));
        await StepAsync("configuration documents", ImportConfigurationAsync);
        await StepAsync("node registry and tokens", ImportNodes);
        await StepAsync("channel bindings", () => CopyDocument(StateDocumentName.Channels, "state/channels.json"));
        await StepAsync("blobs and artifacts", ImportBlobsAsync);
    }

    private async Task StepAsync(string name, Func<long> body)
    {
        Token.ThrowIfCancellationRequested();
        if (options.BeforePhase is { } before)
            await before(name).ConfigureAwait(false);
        report.Phase(name, body, count => count);
    }

    private async Task StepAsync(string name, Func<Task<long>> body)
    {
        Token.ThrowIfCancellationRequested();
        if (options.BeforePhase is { } before)
            await before(name).ConfigureAwait(false);
        await report.PhaseAsync(name, body, count => count).ConfigureAwait(false);
    }

    private long CopyTable(string file, ImportTable table)
    {
        if (Copy(file) is not { } connection)
            return 0;
        var (rows, sha, columns) = ImportTables.Copy(connection, Db, Owner, table, Token);
        foreach (var (column, count) in columns.SourceOnly)
            if (count > 0)
                report.NotImported($"state/{file} {table.Source}.{column}", count, "A source column the hosted table doesn't have; no current reader uses it.");
        return rows;
    }

    private long CopyDocument(StateDocumentName name, string file)
    {
        if (new FileStateDocuments(source.Root).Open(name).ReadText() is not { } text)
            return 0;
        Hosted.Documents.Open(name).ReplaceText(text, Token);
        return 1;
    }

    private long ImportCatalog()
    {
        if (sourceCatalog is null)
            return 0;
        // Copied, not re-projected: a re-projection would drop fields an earlier projection
        // wrote (meta.waitLivenessFingerprints). Verification compares every row's JSON.
        var rows = sourceCatalog.List();
        var catalog = (PgSessionCatalog)Hosted.Catalog;
        foreach (var chunk in rows.Chunk(200))
        {
            Token.ThrowIfCancellationRequested();
            catalog.Import(chunk);
        }
        return rows.Length;
    }

    private long ImportSessionDocuments()
    {
        long count = 0;
        var authority = Hosted.Authority;
        foreach (var (id, path) in source.SessionDocuments())
        {
            Token.ThrowIfCancellationRequested();
            if (ReadDocument(id, path) is not { } document)
                continue;
            authority.ReplaceRaw(id, document);
            count++;
        }
        return count;
    }

    // An authority document as stored, or null (with a report line) when it can't be imported.
    private JsonObject? ReadDocument(string id, string path)
    {
        if (!SessionIdentity.IsValid(id))
        {
            report.NotImported("state/sessions/" + id + ".json", 1, "Not a valid Session ID.");
            return null;
        }
        try
        {
            using var stream = File.OpenRead(path);
            if (JsonNode.Parse(stream) is JsonObject document)
                return document;
        }
        catch (System.Text.Json.JsonException) { }
        report.NotImported("state/sessions/" + id + ".json", 1, "Not a JSON object; no catalog row refers to it.");
        return null;
    }

    private long ImportArchive()
    {
        if (Copy("archive-store.sqlite") is not { } connection)
            return 0;
        var ids = new List<string>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT session_id FROM archive_messages UNION SELECT session_id FROM archive_blocks ORDER BY 1";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                ids.Add(reader.GetString(0));
        }
        var file = new SqliteArchiveStore(work);
        long rows = 0;
        foreach (var id in ids)
        {
            Token.ThrowIfCancellationRequested();
            var session = file.ForSession(id);
            foreach (var chunk in Batches(session.ReadBlocks(), block => block.Summary.Length + 256))
            {
                var batch = PgArchiveBatch.Import(id, chunk, []);
                Db.Write(tx => PgArchiveRows.Insert(tx, batch));
                rows += chunk.Count;
            }
            foreach (var chunk in Batches(session.ReadMessages(), message => message.MessageJson.Length + 128))
            {
                var batch = PgArchiveBatch.Import(id, [], chunk);
                Db.Write(tx => PgArchiveRows.Insert(tx, batch));
                rows += chunk.Count;
            }
        }
        return rows + CopyTable("archive-store.sqlite", ArchiveBranches);
    }

    private static IEnumerable<List<T>> Batches<T>(IEnumerable<T> items, Func<T, long> size)
    {
        var batch = new List<T>();
        long bytes = 0;
        foreach (var item in items)
        {
            batch.Add(item);
            bytes += size(item);
            if (batch.Count >= 500 || bytes >= 4L * 1024 * 1024)
            {
                yield return batch;
                batch = [];
                bytes = 0;
            }
        }
        if (batch.Count > 0)
            yield return batch;
    }

    private List<string> ToolScriptRunIds()
    {
        var directory = Path.Combine(source.State, "toolscript-runs");
        return Directory.Exists(directory)
            ? Directory.EnumerateFiles(directory, "*.json").Select(path => Path.GetFileNameWithoutExtension(path)!).Order(StringComparer.Ordinal).ToList()
            : [];
    }

    private async Task<long> ImportToolScriptRunsAsync()
    {
        var file = new Foxwarm.ToolScript.ToolScriptRunStore(source.Root);
        long count = 0;
        foreach (var id in ToolScriptRunIds())
        {
            Token.ThrowIfCancellationRequested();
            JsonObject? record;
            try
            {
                record = await file.ReadAsync(id, Token).ConfigureAwait(false);
            }
            catch (Exception error) when (error is System.Text.Json.JsonException or InvalidDataException or ArgumentException)
            {
                report.NotImported("state/toolscript-runs/" + id + ".json", 1, "Unreadable in file mode too: " + error.Message);
                continue;
            }
            if (record is null)
                continue;
            await Hosted.ToolScriptRuns.WriteAsync(record, Token).ConfigureAwait(false);
            count++;
        }
        return count;
    }

    private long ImportJournal()
    {
        if (Copy("llm-request-journal.sqlite") is not { } connection)
            return 0;
        long rows = CopyTable("llm-request-journal.sqlite", UsageLedger) + CopyTable("llm-request-journal.sqlite", RedactionLedger);
        foreach (var table in JournalContent)
            rows += CopyTable("llm-request-journal.sqlite", table);
        if (options.Journal && ImportTables.SourceHas(connection, "llm_journal_requests"))
        {
            using var command = connection.CreateCommand();
            command.CommandText =
                "SELECT request_id, prompt_object_id, tool_schema_object_id, checkpoint_message_ids_json, appended_message_ids_json FROM llm_journal_requests ORDER BY request_id";
            using var reader = command.ExecuteReader();
            var batch = new List<(string, string[])>();
            void Flush()
            {
                if (batch.Count == 0)
                    return;
                var rowsToWrite = batch.ToArray();
                Db.Write(tx => PgLlmJournalStore.ImportRequestObjects(tx, rowsToWrite));
                batch.Clear();
            }
            while (reader.Read())
            {
                batch.Add((
                    reader.GetString(0),
                    PgLlmJournalStore.RequestObjects(
                        reader.GetString(1),
                        reader.GetString(2),
                        reader.IsDBNull(3) ? null : reader.GetString(3),
                        reader.IsDBNull(4) ? null : reader.GetString(4)
                    )
                ));
                if (batch.Count >= 500)
                    Flush();
            }
            Flush();
        }
        return rows;
    }

    private long ImportNodes()
    {
        var count = CopyDocument(StateDocumentName.Nodes, "state/nodes.json");
        var file = new FileInstanceCredentials(source.Root);
        foreach (var name in Enum.GetValues<InstanceCredentialName>())
        {
            if (file.Read(name) is not { } value)
            {
                report.Warn($"The source has no {PgInstanceCredentials.Key(name)}; hosted mode creates a new one at the first start.");
                continue;
            }
            var stored = Hosted.Credentials.ReadOrCreate(name, () => value);
            if (stored != value)
                report.Fail($"Instance credential {PgInstanceCredentials.Key(name)} differs from the source after import.");
            count++;
        }
        return count;
    }

    // ---- Configuration documents ----

    private async Task<long> ImportConfigurationAsync()
    {
        var documents = Hosted.ConfigDocuments("import");
        var paths = HostPaths.ForDataRoot(Path.Combine(work, "scratch")) with { AgentsRoot = Path.Combine(work, "agents") };
        var configuration = new ModelConfiguration(
            paths,
            new ConfigurationSources(
                documents,
                config?.Deployment ?? new JsonObject(),
                hostPaths => new InstanceSecrets(
                    hostPaths.DataRoot,
                    keyRing: Hosted.KeyRing,
                    documents: Hosted.Documents,
                    openTextRedaction: key => Hosted.OpenTextRedaction(key)
                ),
                Hosted.Credentials
            )
        );
        long count = 0;
        // The app document first: the first models installation seeds a missing one from the
        // template.
        if (config is not null)
        {
            await configuration.InstallAsync("config", _ => Task.FromResult(Encoding.UTF8.GetBytes(config.TenantText)), token: Token).ConfigureAwait(false);
            count++;
        }
        if (source.ReadBytes("state/models.yaml") is { } models)
        {
            await configuration.InstallAsync("models", _ => Task.FromResult(models), token: Token).ConfigureAwait(false);
            count++;
        }
        if (source.ReadBytes("state/tool-authorization.yaml") is { } rules)
        {
            await new Foxwarm.Tools.ToolAuthorizationAuthority(documents).InstallAsync(rules, Token).ConfigureAwait(false);
            count++;
        }
        if (source.ReadBytes("state/mcp.json") is { } mcp)
        {
            await documents.ReplaceAsync(ConfigDocumentName.Mcp, AdmitMcp(mcp), Token).ConfigureAwait(false);
            // The hosted load rules, as a replica applies them at startup.
            _ = new McpConfiguration(documents) { StdioAvailable = false }.Snapshot();
            count++;
        }
        if (source.ReadBytes("state/webui.json") is { } webui)
        {
            if (JsonNode.Parse(ConfigDocumentText.Decode(webui)) is not JsonObject)
                throw new InvalidDataException("state/webui.json isn't a JSON object.");
            await documents.ReplaceAsync(ConfigDocumentName.WebUi, webui, Token).ConfigureAwait(false);
            count++;
        }
        return count;
    }

    // The MCP document verbatim, unless it has stdio servers: hosted mode refuses them, so they
    // are dropped (and listed in the report) and the rest is written the way Main writes it.
    private byte[] AdmitMcp(byte[] bytes)
    {
        var document = JsonNode.Parse(ConfigDocumentText.Decode(bytes)) as JsonObject
            ?? throw new InvalidDataException("state/mcp.json isn't a JSON object.");
        if (document["servers"] is not JsonObject servers)
            return bytes;
        var stdio = servers.Where(pair => SessionWait.Text(pair.Value?["transport"]) == "stdio").Select(pair => pair.Key).ToList();
        if (stdio.Count == 0)
            return bytes;
        var dropped = report.Root["configuration"]?["droppedSettings"]?.AsArray();
        foreach (var name in stdio)
        {
            dropped?.Add(new JsonObject { ["key"] = "mcp.servers." + name, ["value"] = servers[name]?.DeepClone() });
            servers.Remove(name);
        }
        return new UTF8Encoding(false).GetBytes(new JsonObject { ["servers"] = servers.DeepClone() }.ToJsonText());
    }

    // ---- Blobs ----

    private List<string> ImageBlobKeys()
    {
        var root = Path.Combine(source.State, "image-blobs");
        if (!Directory.Exists(root))
            return [];
        return Directory
            .EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Where(path => !path.EndsWith(".tmp", StringComparison.Ordinal))
            .Select(path => (Directory: Path.GetFileName(Path.GetDirectoryName(path))!, Name: Path.GetFileName(path)))
            .Where(item => item.Name.Length > 2 && item.Name[..2] == item.Directory)
            .Select(item => item.Name)
            .Order(StringComparer.Ordinal)
            .ToList();
    }

    private List<string> ArtifactKeys()
    {
        var root = Path.Combine(source.State, "artifacts");
        if (!Directory.Exists(root))
            return [];
        return Directory
            .EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Where(path => !path.EndsWith(".tmp", StringComparison.Ordinal))
            .Select(path => Path.GetRelativePath(root, path).Replace(Path.DirectorySeparatorChar, '/'))
            .Order(StringComparer.Ordinal)
            .ToList();
    }

    private async Task<long> ImportBlobsAsync()
    {
        var images = ImageBlobKeys();
        var artifacts = ArtifactKeys();
        if (images.Count + artifacts.Count == 0)
            return 0;
        var (imageStore, artifactStore) = (Hosted.ImageBlobs, Hosted.ArtifactBlobs);
        var sourceImages = new Foxwarm.Images.ImageBlobFiles(source.Root);
        var sourceArtifacts = new Foxwarm.Artifacts.ArtifactBlobFiles(Path.Combine(source.State, "artifacts"));
        long count = 0;
        foreach (var (keys, from, to) in new[] { (images, (IBlobStore)sourceImages, imageStore), (artifacts, sourceArtifacts, artifactStore) })
            foreach (var key in keys)
            {
                Token.ThrowIfCancellationRequested();
                var content = await from.ReadAllAsync(key, Token).ConfigureAwait(false);
                // An object left by an earlier failed import of the same tenant is kept; the
                // hash check below then decides.
                await to.CreateAsync(key, content, keepExisting: true, Token).ConfigureAwait(false);
                count++;
            }
        return count;
    }
}
