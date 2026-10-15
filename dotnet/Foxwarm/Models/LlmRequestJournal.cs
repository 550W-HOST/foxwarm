using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Models;

internal sealed class LlmJournalPreparationException(string message, Exception inner)
    : Exception(message, inner);

internal sealed record LlmJournalRequest(
    string RequestId,
    string? SessionId,
    string Purpose,
    int Iteration,
    string RequestedModelKey,
    string Prompt,
    JsonArray ToolDefinitions,
    JsonArray Messages,
    string PromptCacheKeyHash
);

public sealed class LlmRequestJournalStore : IDisposable
{
    internal const string MigrationId = "sqlite-only-large-archives-v1";
    private const int MaxDeltaDepth = 8;
    private readonly string root;
    private readonly string path;
    private readonly SemaphoreSlim gate = new(1, 1);
    private bool disposed;

    public LlmRequestJournalStore(string root)
    {
        this.root = Path.GetFullPath(root);
        path = Path.Combine(this.root, "state", "llm-request-journal.sqlite");
    }

    public string FilePath => path;

    public async Task InitializeAsync(CancellationToken token = default)
    {
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<string> BeginRequestAsync(
        string? sessionId,
        string purpose,
        int iteration,
        string systemPrompt,
        JsonArray toolDefinitions,
        IReadOnlyList<JsonObject> messages,
        string requestedModelKey,
        string promptCacheKey,
        CancellationToken token = default
    )
    {
        var requestId = Guid.NewGuid().ToString();
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
            using var transaction = connection.BeginTransaction(deferred: false);
            var promptId = PutObject(
                connection,
                transaction,
                "prompt",
                JsonValue.Create(systemPrompt)!
            );
            var toolId = PutObject(connection, transaction, "tool-schema", toolDefinitions);
            var canonicalMessages = messages
                .Where(message =>
                    message["modelVisible"] is not JsonValue visibility
                    || !visibility.TryGetValue<bool>(out var visible)
                    || visible
                )
                .Select(CanonicalMessage)
                .ToArray();
            var messageIds = canonicalMessages
                .Select(message => PutObject(connection, transaction, "message", message))
                .ToArray();
            string? baseRequest = null;
            int? commonPrefix = null;
            var deltaDepth = 0;
            if (!string.IsNullOrEmpty(sessionId))
            {
                var prior = ReadLatestRequest(connection, transaction, sessionId!);
                if (prior is not null && prior.Value.Depth < MaxDeltaDepth)
                {
                    var priorIds = ReconstructIds(connection, transaction, prior.Value.RequestId);
                    var prefix = 0;
                    while (
                        prefix < priorIds.Count
                        && prefix < messageIds.Length
                        && priorIds[prefix] == messageIds[prefix]
                    )
                        prefix++;
                    baseRequest = prior.Value.RequestId;
                    commonPrefix = prefix;
                    deltaDepth = prior.Value.Depth + 1;
                }
            }
            var checkpoint = baseRequest is null ? JsonSerializer.Serialize(messageIds) : null;
            var appended = baseRequest is null
                ? null
                : JsonSerializer.Serialize(messageIds[(commonPrefix ?? 0)..]);
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                INSERT INTO llm_journal_requests(
                    request_id,session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,
                    requested_model_key,prompt_cache_key_hash,message_count,checkpoint_message_ids_json,
                    base_request_id,common_prefix_length,appended_message_ids_json,delta_depth
                ) VALUES($id,$session,$purpose,$iteration,$created,$prompt,$schema,$model,$cache,$count,$checkpoint,$base,$prefix,$appended,$depth)
                """;
            Add(command, "$id", requestId);
            Add(command, "$session", sessionId);
            Add(command, "$purpose", purpose);
            Add(command, "$iteration", iteration);
            Add(command, "$created", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Add(command, "$prompt", promptId);
            Add(command, "$schema", toolId);
            Add(command, "$model", requestedModelKey);
            Add(command, "$cache", Sha256(promptCacheKey));
            Add(command, "$count", messageIds.Length);
            Add(command, "$checkpoint", checkpoint);
            Add(command, "$base", baseRequest);
            Add(command, "$prefix", commonPrefix);
            Add(command, "$appended", appended);
            Add(command, "$depth", deltaDepth);
            command.ExecuteNonQuery();
            transaction.Commit();
            return requestId;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task AppendAttemptStartAsync(
        string requestId,
        int attempt,
        string concreteModelId,
        string? virtualModelKey,
        string providerType,
        JsonNode semanticPayload,
        string effectivePrompt,
        CancellationToken token = default
    )
    {
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
            using var transaction = connection.BeginTransaction(deferred: false);
            var promptId =
                ReadScalar(
                    connection,
                    transaction,
                    "SELECT prompt_object_id FROM llm_journal_requests WHERE request_id=$id",
                    ("$id", requestId)
                ) as string
                ?? throw new InvalidDataException(
                    "LLM journal request is missing before attempt start."
                );
            var effectiveId = ObjectId("prompt", JsonValue.Create(effectivePrompt)!);
            string? overrideId = null;
            if (attempt == 1 && effectiveId != promptId)
                throw new InvalidDataException(
                    "First LLM journal attempt must use the request prompt."
                );
            if (effectiveId != promptId)
                overrideId = PutObject(
                    connection,
                    transaction,
                    "prompt",
                    JsonValue.Create(effectivePrompt)!
                );
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                "INSERT INTO llm_journal_attempt_starts(event_id,request_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256,prompt_object_id) VALUES($event,$request,$attempt,$started,$model,$virtual,$provider,$hash,$prompt)";
            Add(command, "$event", Guid.NewGuid().ToString());
            Add(command, "$request", requestId);
            Add(command, "$attempt", attempt);
            Add(command, "$started", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Add(command, "$model", concreteModelId);
            Add(command, "$virtual", virtualModelKey);
            Add(command, "$provider", providerType);
            Add(command, "$hash", HashValue(semanticPayload));
            Add(command, "$prompt", overrideId);
            command.ExecuteNonQuery();
            transaction.Commit();
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task AppendAttemptResultAsync(
        string requestId,
        int attempt,
        string outcome,
        JsonNode? result,
        JsonObject? error,
        CancellationToken token = default
    )
    {
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
            using var transaction = connection.BeginTransaction(deferred: false);
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                "INSERT INTO llm_journal_attempt_results(event_id,request_id,attempt,completed_at,outcome,result_json,error_json) VALUES($event,$request,$attempt,$completed,$outcome,$result,$error)";
            Add(command, "$event", Guid.NewGuid().ToString());
            Add(command, "$request", requestId);
            Add(command, "$attempt", attempt);
            Add(command, "$completed", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Add(command, "$outcome", outcome);
            Add(command, "$result", result is null ? null : Codec.Write(result));
            Add(command, "$error", error is null ? null : Codec.Write(error));
            command.ExecuteNonQuery();
            transaction.Commit();
        }
        finally
        {
            gate.Release();
        }
    }

    public Task AppendChatResultAsync(
        string requestId,
        int attempt,
        ChatResult result,
        CancellationToken token = default
    ) =>
        AppendAttemptResultAsync(
            requestId,
            attempt,
            "success",
            ToSourceResult(result),
            null,
            token
        );

    public async Task<JsonObject> ReconstructAsync(
        string requestId,
        CancellationToken token = default
    )
    {
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
            try
            {
                return Reconstruct(connection, requestId);
            }
            catch (Exception error)
            {
                return new JsonObject
                {
                    ["requestId"] = requestId,
                    ["completeness"] = "corrupt",
                    ["errors"] = new JsonArray(error.Message),
                };
            }
        }
        finally
        {
            gate.Release();
        }
    }

    public static string EncodeCli(JsonNode node) => Codec.Write(node);

    public async Task<JsonArray> ListAsync(
        string? sessionId,
        string? purpose,
        long? createdAt,
        string? requestId,
        int limit,
        CancellationToken token = default
    )
    {
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
            using var command = connection.CreateCommand();
            command.CommandText =
                "SELECT request_id,session_id,purpose,iteration,created_at,requested_model_key,message_count FROM llm_journal_requests WHERE ($session IS NULL OR session_id=$session) AND ($purpose IS NULL OR purpose=$purpose) AND ($created IS NULL OR created_at<$created OR (created_at=$created AND request_id<$request)) ORDER BY created_at DESC,request_id DESC LIMIT $limit";
            Add(command, "$session", sessionId);
            Add(command, "$purpose", purpose);
            Add(command, "$created", createdAt);
            Add(command, "$request", requestId ?? "~");
            Add(command, "$limit", Math.Clamp(limit, 1, 1000));
            using var reader = command.ExecuteReader();
            var result = new JsonArray();
            while (reader.Read())
                result.Add(
                    new JsonObject
                    {
                        ["requestId"] = reader.GetString(0),
                        ["sessionId"] = reader.IsDBNull(1) ? null : reader.GetString(1),
                        ["purpose"] = reader.GetString(2),
                        ["iteration"] = reader.GetInt32(3),
                        ["createdAt"] = reader.GetInt64(4),
                        ["requestedModelKey"] = reader.GetString(5),
                        ["messageCount"] = reader.GetInt32(6),
                    }
                );
            return result;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<bool> MigrateLegacyAsync(string sourcePath, CancellationToken token = default)
    {
        var fullPath = Path.GetFullPath(sourcePath);
        SqliteTransaction? transaction = null;
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            if (!File.Exists(fullPath))
                return false;
            using var connection = Open();
            EnsureSchema(connection);
            var sourceLength = new FileInfo(fullPath).Length;
            var imported = ReadImportOffset(connection, fullPath);
            if (imported > sourceLength)
                imported = 0;
            long completeOffset = imported;
            transaction = connection.BeginTransaction(deferred: false);
            var requestIds = new HashSet<string>(StringComparer.Ordinal);
            var recordsInBatch = 0;
            await foreach (var item in ReadJsonlLinesAsync(fullPath, imported, token))
            {
                token.ThrowIfCancellationRequested();
                var line = item.Line;
                completeOffset = item.EndOffset;
                if (line.Length == 0)
                    continue;
                using var document = JsonDocument.Parse(line);
                InsertLegacyRecord(connection, transaction, document.RootElement, requestIds);
                if (++recordsInBatch == 200)
                {
                    transaction.Commit();
                    transaction.Dispose();
                    transaction = connection.BeginTransaction(deferred: false);
                    recordsInBatch = 0;
                }
            }
            foreach (var requestId in requestIds)
                ValidateRequestManifest(connection, transaction, requestId);
            var verificationRequestIds = new HashSet<string>(StringComparer.Ordinal);
            await foreach (var item in ReadJsonlLinesAsync(fullPath, 0, token))
            {
                token.ThrowIfCancellationRequested();
                if (item.Line.Length == 0)
                    continue;
                using var document = JsonDocument.Parse(item.Line);
                VerifyLegacyRecord(connection, transaction, document.RootElement);
                if (
                    document.RootElement.GetProperty("kind").GetString()
                    is "request"
                        or "attempt-start"
                        or "attempt-result"
                )
                    verificationRequestIds.Add(
                        document.RootElement.GetProperty("requestId").GetString()!
                    );
            }
            foreach (var requestId in verificationRequestIds)
            {
                ValidateRequestManifest(connection, transaction, requestId);
                var reconstructed = Reconstruct(connection, requestId);
                if (reconstructed["completeness"]?.GetValue<string>() != "complete")
                    throw new InvalidDataException(
                        $"Legacy LLM request {requestId} failed reconstruction verification."
                    );
            }
            using (var state = connection.CreateCommand())
            {
                state.Transaction = transaction;
                state.CommandText =
                    "INSERT INTO llm_journal_import_state(source_path,imported_size,updated_at) VALUES($path,$size,$updated) ON CONFLICT(source_path) DO UPDATE SET imported_size=excluded.imported_size,updated_at=excluded.updated_at";
                Add(state, "$path", fullPath);
                Add(state, "$size", completeOffset);
                Add(state, "$updated", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                state.ExecuteNonQuery();
            }
            transaction.Commit();
            transaction.Dispose();
            var stateRoot = Path.Combine(root, "state");
            var relative = Path.GetRelativePath(stateRoot, fullPath);
            if (relative.StartsWith("..", StringComparison.Ordinal))
                relative = Path.GetFileName(fullPath);
            var backupPath = Path.Combine(
                stateRoot,
                "migration-backup",
                MigrationId,
                relative + "." + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            );
            Directory.CreateDirectory(Path.GetDirectoryName(backupPath)!);
            File.Move(fullPath, backupPath);
            SyncDirectory(Path.GetDirectoryName(backupPath)!);
            return true;
        }
        catch
        {
            transaction?.Dispose();
            throw;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task MarkSqliteAuthorityAsync(
        string migrationId,
        CancellationToken token = default
    )
    {
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
            using var command = connection.CreateCommand();
            command.CommandText =
                "INSERT OR REPLACE INTO llm_journal_metadata(key,value) VALUES('sqlite_authority_migration',$value)";
            Add(command, "$value", migrationId);
            command.ExecuteNonQuery();
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<bool> HasSqliteAuthorityAsync(
        string migrationId,
        CancellationToken token = default
    )
    {
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
            using var command = connection.CreateCommand();
            command.CommandText =
                "SELECT value FROM llm_journal_metadata WHERE key='sqlite_authority_migration'";
            return string.Equals(
                command.ExecuteScalar() as string,
                migrationId,
                StringComparison.Ordinal
            );
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task ExportJsonlAsync(string outputPath, CancellationToken token = default)
    {
        await gate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var connection = Open();
            EnsureSchema(connection);
            using var snapshot = connection.BeginTransaction(deferred: true);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
            var temp = outputPath + ".tmp-" + Guid.NewGuid().ToString("N");
            await using var stream = new FileStream(
                temp,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                8192,
                true
            );
            using var writer = new StreamWriter(stream, new UTF8Encoding(false));
            foreach (
                var table in new[]
                {
                    "llm_journal_objects",
                    "llm_journal_requests",
                    "llm_journal_attempt_starts",
                    "llm_journal_attempt_results",
                }
            )
            {
                using var command = connection.CreateCommand();
                command.Transaction = snapshot;
                command.CommandText = table switch
                {
                    "llm_journal_objects" =>
                        "SELECT object_id,object_kind,payload,created_at FROM llm_journal_objects ORDER BY rowid",
                    "llm_journal_requests" =>
                        "SELECT request_id,session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,requested_model_key,prompt_cache_key_hash,message_count,checkpoint_message_ids_json,base_request_id,common_prefix_length,appended_message_ids_json,delta_depth FROM llm_journal_requests ORDER BY rowid",
                    "llm_journal_attempt_starts" =>
                        "SELECT event_id,request_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256,prompt_object_id FROM llm_journal_attempt_starts ORDER BY rowid",
                    _ =>
                        "SELECT event_id,request_id,attempt,completed_at,outcome,result_json,error_json FROM llm_journal_attempt_results ORDER BY rowid",
                };
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    JsonObject record = table switch
                    {
                        "llm_journal_objects" => new()
                        {
                            ["v"] = 1,
                            ["kind"] = "object",
                            ["objectId"] = reader.GetString(0),
                            ["objectKind"] = reader.GetString(1),
                            ["payload"] = reader.GetString(2),
                            ["createdAt"] = reader.GetInt64(3),
                        },
                        "llm_journal_requests" => RequestJson(reader),
                        "llm_journal_attempt_starts" => AttemptStartJson(reader),
                        _ => AttemptResultJson(reader),
                    };
                    await writer.WriteLineAsync(Codec.Write(record));
                }
            }
            await writer.FlushAsync(token);
            await stream.FlushAsync(token);
            stream.Flush(true);
            writer.Dispose();
            snapshot.Commit();
            File.Move(temp, outputPath, true);
            SyncDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
        }
        finally
        {
            gate.Release();
        }
    }

    public void Dispose()
    {
        if (!disposed)
        {
            disposed = true;
            gate.Dispose();
        }
    }

    private static void SyncDirectory(string directory)
    {
        try
        {
            using var handle = new FileStream(
                directory,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite
            );
            handle.Flush(true);
        }
        catch (Exception error)
            when (error
                    is IOException
                        or UnauthorizedAccessException
                        or PlatformNotSupportedException
            )
        {
            System.Diagnostics.Trace.TraceWarning(
                "LLM journal directory durability was unavailable: {0}",
                error.Message
            );
        }
    }

    private static async IAsyncEnumerable<(string Line, long EndOffset)> ReadJsonlLinesAsync(
        string path,
        long startOffset,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken token
    )
    {
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            8192,
            true
        );
        stream.Position = startOffset;
        var buffer = new byte[8192];
        var line = new List<byte>();
        var offset = startOffset;
        while (true)
        {
            var count = await stream.ReadAsync(buffer, token).ConfigureAwait(false);
            if (count == 0)
                break;
            for (var index = 0; index < count; index++)
            {
                var value = buffer[index];
                offset++;
                if (value == (byte)'\n')
                {
                    if (line.Count > 0 && line[^1] == (byte)'\r')
                        line.RemoveAt(line.Count - 1);
                    yield return (new UTF8Encoding(false, true).GetString(line.ToArray()), offset);
                    line.Clear();
                }
                else
                {
                    line.Add(value);
                }
            }
        }
        if (line.Count > 0)
            yield return (new UTF8Encoding(false, true).GetString(line.ToArray()), offset);
    }

    private static long ReadImportOffset(SqliteConnection connection, string sourcePath)
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT imported_size FROM llm_journal_import_state WHERE source_path=$path";
        Add(command, "$path", sourcePath);
        var value = command.ExecuteScalar();
        return value is null || value is DBNull
            ? 0
            : Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }

    private static void ValidateLegacyRecordShape(JsonElement record)
    {
        if (
            !record.TryGetProperty("v", out var version)
            || version.ValueKind != JsonValueKind.Number
            || version.GetInt32() != 1
        )
            throw new InvalidDataException("Invalid legacy LLM request journal record version.");
        var kind =
            record.TryGetProperty("kind", out var kindValue)
            && kindValue.ValueKind == JsonValueKind.String
                ? kindValue.GetString()
                : null;
        if (kind is not ("object" or "request" or "attempt-start" or "attempt-result"))
            throw new InvalidDataException("Invalid legacy LLM request journal record kind.");
        var allowed = kind switch
        {
            "object" => new[] { "v", "kind", "objectId", "objectKind", "payload", "createdAt" },
            "request" => new[]
            {
                "v",
                "kind",
                "requestId",
                "sessionId",
                "purpose",
                "iteration",
                "createdAt",
                "promptObjectId",
                "toolSchemaObjectId",
                "requestedModelKey",
                "promptCacheKeyHash",
                "messageCount",
                "checkpointMessageObjectIds",
                "baseRequestId",
                "commonPrefixLength",
                "appendedMessageObjectIds",
                "deltaDepth",
            },
            "attempt-start" => new[]
            {
                "v",
                "kind",
                "eventId",
                "requestId",
                "attempt",
                "startedAt",
                "concreteModelId",
                "virtualModelKey",
                "providerType",
                "semanticPayloadSha256",
                "promptObjectId",
            },
            _ => new[]
            {
                "v",
                "kind",
                "eventId",
                "requestId",
                "attempt",
                "completedAt",
                "outcome",
                "result",
                "error",
            },
        };
        foreach (var property in record.EnumerateObject())
            if (!allowed.Contains(property.Name, StringComparer.Ordinal))
                throw new InvalidDataException(
                    $"Unknown legacy LLM journal field {property.Name}."
                );
        static void RequiredString(JsonElement value, string name)
        {
            if (
                !value.TryGetProperty(name, out var property)
                || property.ValueKind != JsonValueKind.String
            )
                throw new InvalidDataException($"Legacy journal field {name} must be a string.");
        }
        static void RequiredFinite(JsonElement value, string name)
        {
            if (
                !value.TryGetProperty(name, out var property)
                || property.ValueKind != JsonValueKind.Number
                || !double.IsFinite(property.GetDouble())
            )
                throw new InvalidDataException($"Legacy journal field {name} must be finite.");
        }
        static void RequiredInteger(
            JsonElement value,
            string name,
            int minimum,
            int maximum = int.MaxValue
        )
        {
            if (
                !value.TryGetProperty(name, out var property)
                || property.ValueKind != JsonValueKind.Number
                || !property.TryGetInt32(out var number)
                || number < minimum
                || number > maximum
            )
                throw new InvalidDataException(
                    $"Legacy journal field {name} must be an integer in range."
                );
        }
        static void OptionalString(JsonElement value, string name)
        {
            if (
                value.TryGetProperty(name, out var property)
                && property.ValueKind != JsonValueKind.String
            )
                throw new InvalidDataException(
                    $"Legacy journal field {name} must be omitted or a string."
                );
        }
        static void Sha256String(JsonElement value, string name)
        {
            RequiredString(value, name);
            var text = value.GetProperty(name).GetString()!;
            if (
                text.Length != 71
                || !text.StartsWith("sha256:", StringComparison.Ordinal)
                || text[7..].Any(character => !Uri.IsHexDigit(character) || char.IsUpper(character))
            )
                throw new InvalidDataException(
                    $"Legacy journal field {name} is not a lowercase sha256 identifier."
                );
        }
        switch (kind)
        {
            case "object":
                RequiredString(record, "objectId");
                RequiredString(record, "objectKind");
                RequiredString(record, "payload");
                RequiredFinite(record, "createdAt");
                if (
                    record.GetProperty("objectKind").GetString()
                    is not ("prompt" or "tool-schema" or "message")
                )
                    throw new InvalidDataException("Invalid legacy object kind.");
                if (
                    Sha256(
                        record.GetProperty("objectKind").GetString()!
                            + "\0"
                            + record.GetProperty("payload").GetString()!
                    ) != record.GetProperty("objectId").GetString()
                )
                    throw new InvalidDataException("Legacy object hash mismatch.");
                break;
            case "request":
                RequiredString(record, "requestId");
                OptionalString(record, "sessionId");
                RequiredString(record, "purpose");
                RequiredInteger(record, "iteration", 0);
                RequiredFinite(record, "createdAt");
                RequiredString(record, "promptObjectId");
                RequiredString(record, "toolSchemaObjectId");
                RequiredString(record, "requestedModelKey");
                Sha256String(record, "promptCacheKeyHash");
                RequiredInteger(record, "messageCount", 0);
                RequiredInteger(record, "deltaDepth", 0, 8);
                if (
                    record.GetProperty("purpose").GetString()
                    is not (
                        "normal-turn"
                        or "compact-plan"
                        or "btw"
                        or "toolscript-one-shot"
                        or "cli"
                        or "setup-test"
                        or "low-level"
                    )
                )
                    throw new InvalidDataException("Invalid legacy journal purpose.");
                var checkpoint = record.TryGetProperty(
                    "checkpointMessageObjectIds",
                    out var checkpointValue
                );
                var delta =
                    record.TryGetProperty("baseRequestId", out var baseValue)
                    || record.TryGetProperty("commonPrefixLength", out _)
                    || record.TryGetProperty("appendedMessageObjectIds", out _);
                if (
                    checkpoint == delta
                    || checkpoint && record.GetProperty("deltaDepth").GetInt32() != 0
                )
                    throw new InvalidDataException(
                        "Legacy request checkpoint/delta shape is invalid."
                    );
                if (checkpointValue.ValueKind != JsonValueKind.Array && checkpoint)
                    throw new InvalidDataException("Legacy checkpoint ids must be an array.");
                if (delta)
                {
                    if (
                        !record.TryGetProperty("baseRequestId", out var baseRequest)
                        || baseRequest.ValueKind != JsonValueKind.String
                        || !record.TryGetProperty("commonPrefixLength", out var common)
                        || common.ValueKind != JsonValueKind.Number
                        || !common.TryGetInt32(out var prefix)
                        || prefix < 0
                        || !record.TryGetProperty("appendedMessageObjectIds", out var appended)
                        || appended.ValueKind != JsonValueKind.Array
                    )
                        throw new InvalidDataException("Legacy request delta shape is invalid.");
                }
                break;
            case "attempt-start":
                RequiredString(record, "eventId");
                RequiredString(record, "requestId");
                RequiredInteger(record, "attempt", 1);
                RequiredFinite(record, "startedAt");
                RequiredString(record, "concreteModelId");
                OptionalString(record, "virtualModelKey");
                RequiredString(record, "providerType");
                Sha256String(record, "semanticPayloadSha256");
                if (record.TryGetProperty("promptObjectId", out var prompt))
                    Sha256String(record, "promptObjectId");
                break;
            default:
                RequiredString(record, "eventId");
                RequiredString(record, "requestId");
                RequiredInteger(record, "attempt", 1);
                RequiredFinite(record, "completedAt");
                RequiredString(record, "outcome");
                if (
                    record.GetProperty("outcome").GetString()
                    is not ("success" or "failure" or "abort")
                )
                    throw new InvalidDataException("Invalid legacy attempt outcome.");
                if (
                    record.GetProperty("outcome").GetString() == "success"
                    && (
                        !record.TryGetProperty("result", out var result)
                        || result.ValueKind != JsonValueKind.Object
                    )
                )
                    throw new InvalidDataException("Legacy success result is missing.");
                if (
                    record.GetProperty("outcome").GetString() != "success"
                    && (
                        !record.TryGetProperty("error", out var error)
                        || error.ValueKind != JsonValueKind.Object
                    )
                )
                    throw new InvalidDataException("Legacy attempt error is missing.");
                break;
        }
    }

    private static void InsertLegacyRecord(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement record,
        HashSet<string> requestIds
    )
    {
        ValidateLegacyRecordShape(record);
        if (
            !record.TryGetProperty("v", out var version)
            || version.GetInt32() != 1
            || !record.TryGetProperty("kind", out var kindProperty)
        )
            throw new InvalidDataException("Invalid legacy LLM request journal record.");
        var kind = kindProperty.GetString();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        switch (kind)
        {
            case "object":
                var objectId =
                    record.GetProperty("objectId").GetString()
                    ?? throw new InvalidDataException("Legacy object is missing objectId.");
                var objectKind =
                    record.GetProperty("objectKind").GetString()
                    ?? throw new InvalidDataException("Legacy object is missing objectKind.");
                var payload =
                    record.GetProperty("payload").GetString()
                    ?? throw new InvalidDataException("Legacy object is missing payload.");
                if (Sha256(objectKind + "\0" + payload) != objectId)
                    throw new InvalidDataException("Legacy object hash mismatch.");
                command.CommandText =
                    "INSERT OR IGNORE INTO llm_journal_objects(object_id,object_kind,payload,created_at) VALUES($id,$kind,$payload,$created)";
                Add(command, "$id", objectId);
                Add(command, "$kind", objectKind);
                Add(command, "$payload", payload);
                Add(command, "$created", record.GetProperty("createdAt").GetInt64());
                command.ExecuteNonQuery();
                VerifyLegacyObjectConflict(connection, transaction, record);
                break;
            case "request":
                var requestId =
                    record.GetProperty("requestId").GetString()
                    ?? throw new InvalidDataException("Legacy request is missing requestId.");
                command.CommandText =
                    "INSERT OR IGNORE INTO llm_journal_requests(request_id,session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,requested_model_key,prompt_cache_key_hash,message_count,checkpoint_message_ids_json,base_request_id,common_prefix_length,appended_message_ids_json,delta_depth) VALUES($id,$session,$purpose,$iteration,$created,$prompt,$schema,$model,$cache,$count,$checkpoint,$base,$prefix,$appended,$depth)";
                Add(command, "$id", requestId);
                Add(command, "$session", OptionalString(record, "sessionId"));
                Add(command, "$purpose", record.GetProperty("purpose").GetString());
                Add(command, "$iteration", record.GetProperty("iteration").GetInt32());
                Add(command, "$created", record.GetProperty("createdAt").GetInt64());
                Add(command, "$prompt", record.GetProperty("promptObjectId").GetString());
                Add(command, "$schema", record.GetProperty("toolSchemaObjectId").GetString());
                Add(command, "$model", record.GetProperty("requestedModelKey").GetString());
                Add(command, "$cache", record.GetProperty("promptCacheKeyHash").GetString());
                Add(command, "$count", record.GetProperty("messageCount").GetInt32());
                Add(command, "$checkpoint", RawArray(record, "checkpointMessageObjectIds"));
                Add(command, "$base", OptionalString(record, "baseRequestId"));
                Add(command, "$prefix", OptionalInt(record, "commonPrefixLength"));
                Add(command, "$appended", RawArray(record, "appendedMessageObjectIds"));
                Add(command, "$depth", record.GetProperty("deltaDepth").GetInt32());
                command.ExecuteNonQuery();
                VerifyLegacyRequestConflict(connection, transaction, record, requestId);
                requestIds.Add(requestId);
                break;
            case "attempt-start":
                command.CommandText =
                    "INSERT OR IGNORE INTO llm_journal_attempt_starts(event_id,request_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256,prompt_object_id) VALUES($event,$request,$attempt,$started,$model,$virtual,$provider,$hash,$prompt)";
                Add(command, "$event", record.GetProperty("eventId").GetString());
                Add(command, "$request", record.GetProperty("requestId").GetString());
                Add(command, "$attempt", record.GetProperty("attempt").GetInt32());
                Add(command, "$started", record.GetProperty("startedAt").GetInt64());
                Add(command, "$model", record.GetProperty("concreteModelId").GetString());
                Add(command, "$virtual", OptionalString(record, "virtualModelKey"));
                Add(command, "$provider", record.GetProperty("providerType").GetString());
                Add(command, "$hash", record.GetProperty("semanticPayloadSha256").GetString());
                Add(command, "$prompt", OptionalString(record, "promptObjectId"));
                command.ExecuteNonQuery();
                VerifyLegacyAttemptStartConflict(connection, transaction, record);
                requestIds.Add(record.GetProperty("requestId").GetString()!);
                break;
            case "attempt-result":
                command.CommandText =
                    "INSERT OR IGNORE INTO llm_journal_attempt_results(event_id,request_id,attempt,completed_at,outcome,result_json,error_json) VALUES($event,$request,$attempt,$completed,$outcome,$result,$error)";
                Add(command, "$event", record.GetProperty("eventId").GetString());
                Add(command, "$request", record.GetProperty("requestId").GetString());
                Add(command, "$attempt", record.GetProperty("attempt").GetInt32());
                Add(command, "$completed", record.GetProperty("completedAt").GetInt64());
                Add(command, "$outcome", record.GetProperty("outcome").GetString());
                Add(command, "$result", RawJson(record, "result"));
                Add(command, "$error", RawJson(record, "error"));
                command.ExecuteNonQuery();
                VerifyLegacyAttemptResultConflict(connection, transaction, record);
                requestIds.Add(record.GetProperty("requestId").GetString()!);
                break;
            default:
                throw new InvalidDataException("Invalid legacy LLM request journal record kind.");
        }
    }

    private static void ValidateRequestManifest(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string requestId
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "SELECT prompt_object_id,tool_schema_object_id,message_count FROM llm_journal_requests WHERE request_id=$id";
        Add(command, "$id", requestId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            throw new InvalidDataException("Legacy request references missing manifest.");
        var prompt = reader.GetString(0);
        var schema = reader.GetString(1);
        var count = reader.GetInt32(2);
        reader.Close();
        if (
            Codec.Parse(ReadObject(connection, prompt, "prompt")) is not JsonValue promptValue
            || !promptValue.TryGetValue<string>(out _)
        )
            throw new InvalidDataException("Legacy prompt object has invalid payload.");
        if (Codec.Parse(ReadObject(connection, schema, "tool-schema")) is not JsonArray)
            throw new InvalidDataException("Legacy tool-schema object has invalid payload.");
        var messageIds = ReconstructIds(connection, transaction, requestId);
        if (messageIds.Count != count)
            throw new InvalidDataException("Legacy request message count mismatch.");
        foreach (var messageId in messageIds)
        {
            if (
                Codec.Parse(ReadObject(connection, messageId, "message")) is not JsonObject message
                || message["role"] is not JsonValue role
                || !role.TryGetValue<string>(out _)
                || message["parts"] is not JsonArray
            )
                throw new InvalidDataException("Legacy message object has invalid payload.");
        }
        using var starts = connection.CreateCommand();
        starts.Transaction = transaction;
        starts.CommandText =
            "SELECT attempt,prompt_object_id FROM llm_journal_attempt_starts WHERE request_id=$id";
        Add(starts, "$id", requestId);
        using var startReader = starts.ExecuteReader();
        var attempts = new HashSet<int>();
        while (startReader.Read())
        {
            var attempt = startReader.GetInt32(0);
            if (attempt < 1 || !attempts.Add(attempt))
                throw new InvalidDataException(
                    "Legacy request has duplicate attempt-start records."
                );
            if (
                attempt == 1
                && !startReader.IsDBNull(1)
                && !string.Equals(startReader.GetString(1), prompt, StringComparison.Ordinal)
            )
                throw new InvalidDataException(
                    "Legacy request attempt 1 prompt differs from request prompt."
                );
            if (!startReader.IsDBNull(1))
            {
                if (
                    Codec.Parse(ReadObject(connection, startReader.GetString(1), "prompt"))
                        is not JsonValue overridePrompt
                    || !overridePrompt.TryGetValue<string>(out _)
                )
                    throw new InvalidDataException("Legacy attempt prompt override is invalid.");
            }
        }
        using var results = connection.CreateCommand();
        results.Transaction = transaction;
        results.CommandText =
            "SELECT attempt,outcome,result_json,error_json FROM llm_journal_attempt_results WHERE request_id=$id";
        Add(results, "$id", requestId);
        using var resultReader = results.ExecuteReader();
        while (resultReader.Read())
        {
            var attempt = resultReader.GetInt32(0);
            var outcome = resultReader.GetString(1);
            if (!attempts.Contains(attempt) || outcome is not ("success" or "failure" or "abort"))
                throw new InvalidDataException(
                    "Legacy request has an orphaned or invalid attempt result."
                );
            if (
                outcome == "success" && resultReader.IsDBNull(2)
                || outcome != "success" && resultReader.IsDBNull(3)
            )
                throw new InvalidDataException("Legacy attempt result payload is missing.");
            if (
                !resultReader.IsDBNull(2)
                && Codec.Parse(resultReader.GetString(2)) is not JsonObject
            )
                throw new InvalidDataException("Legacy success result payload is invalid.");
            if (
                !resultReader.IsDBNull(3)
                && Codec.Parse(resultReader.GetString(3)) is not JsonObject
            )
                throw new InvalidDataException("Legacy attempt error payload is invalid.");
        }
    }

    private static void VerifyLegacyObjectConflict(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement record
    )
    {
        var objectId = record.GetProperty("objectId").GetString();
        using var verify = connection.CreateCommand();
        verify.Transaction = transaction;
        verify.CommandText =
            "SELECT object_kind,payload,created_at FROM llm_journal_objects WHERE object_id=$id";
        Add(verify, "$id", objectId);
        using var existing = verify.ExecuteReader();
        if (
            !existing.Read()
            || existing.GetString(0) != record.GetProperty("objectKind").GetString()
            || existing.GetString(1) != record.GetProperty("payload").GetString()
            || existing.GetInt64(2) != record.GetProperty("createdAt").GetInt64()
        )
            throw new InvalidDataException("Legacy object conflicts with SQLite authority.");
    }

    private static void VerifyLegacyRecord(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement record
    )
    {
        ValidateLegacyRecordShape(record);
        switch (record.GetProperty("kind").GetString())
        {
            case "object":
                VerifyLegacyObjectConflict(connection, transaction, record);
                break;
            case "request":
                VerifyLegacyRequestConflict(
                    connection,
                    transaction,
                    record,
                    record.GetProperty("requestId").GetString()!
                );
                break;
            case "attempt-start":
                VerifyLegacyAttemptStartConflict(connection, transaction, record);
                break;
            case "attempt-result":
                VerifyLegacyAttemptResultConflict(connection, transaction, record);
                break;
            default:
                throw new InvalidDataException("Legacy journal record kind is unsupported.");
        }
    }

    private static void VerifyLegacyRequestConflict(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement record,
        string requestId
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "SELECT session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,requested_model_key,prompt_cache_key_hash,message_count,checkpoint_message_ids_json,base_request_id,common_prefix_length,appended_message_ids_json,delta_depth FROM llm_journal_requests WHERE request_id=$id";
        Add(command, "$id", requestId);
        using var row = command.ExecuteReader();
        if (
            !row.Read()
            || OptionalReaderString(row, 0) != OptionalString(record, "sessionId")
            || row.GetString(1) != record.GetProperty("purpose").GetString()
            || row.GetInt32(2) != record.GetProperty("iteration").GetInt32()
            || row.GetInt64(3) != record.GetProperty("createdAt").GetInt64()
            || row.GetString(4) != record.GetProperty("promptObjectId").GetString()
            || row.GetString(5) != record.GetProperty("toolSchemaObjectId").GetString()
            || row.GetString(6) != record.GetProperty("requestedModelKey").GetString()
            || row.GetString(7) != record.GetProperty("promptCacheKeyHash").GetString()
            || row.GetInt32(8) != record.GetProperty("messageCount").GetInt32()
            || OptionalReaderJson(row, 9)
                != CanonicalOptionalJson(record, "checkpointMessageObjectIds")
            || OptionalReaderString(row, 10) != OptionalString(record, "baseRequestId")
            || OptionalReaderInt(row, 11) != OptionalInt(record, "commonPrefixLength")
            || OptionalReaderJson(row, 12)
                != CanonicalOptionalJson(record, "appendedMessageObjectIds")
            || row.GetInt32(13) != record.GetProperty("deltaDepth").GetInt32()
        )
            throw new InvalidDataException("Legacy request conflicts with SQLite authority.");
    }

    private static void VerifyLegacyAttemptStartConflict(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement record
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "SELECT request_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256,prompt_object_id FROM llm_journal_attempt_starts WHERE event_id=$id";
        Add(command, "$id", record.GetProperty("eventId").GetString());
        using var row = command.ExecuteReader();
        if (
            !row.Read()
            || row.GetString(0) != record.GetProperty("requestId").GetString()
            || row.GetInt32(1) != record.GetProperty("attempt").GetInt32()
            || row.GetInt64(2) != record.GetProperty("startedAt").GetInt64()
            || row.GetString(3) != record.GetProperty("concreteModelId").GetString()
            || OptionalReaderString(row, 4) != OptionalString(record, "virtualModelKey")
            || row.GetString(5) != record.GetProperty("providerType").GetString()
            || row.GetString(6) != record.GetProperty("semanticPayloadSha256").GetString()
            || OptionalReaderString(row, 7) != OptionalString(record, "promptObjectId")
        )
            throw new InvalidDataException("Legacy attempt-start conflicts with SQLite authority.");
    }

    private static void VerifyLegacyAttemptResultConflict(
        SqliteConnection connection,
        SqliteTransaction transaction,
        JsonElement record
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "SELECT request_id,attempt,completed_at,outcome,result_json,error_json FROM llm_journal_attempt_results WHERE event_id=$id";
        Add(command, "$id", record.GetProperty("eventId").GetString());
        using var row = command.ExecuteReader();
        if (
            !row.Read()
            || row.GetString(0) != record.GetProperty("requestId").GetString()
            || row.GetInt32(1) != record.GetProperty("attempt").GetInt32()
            || row.GetInt64(2) != record.GetProperty("completedAt").GetInt64()
            || row.GetString(3) != record.GetProperty("outcome").GetString()
            || OptionalReaderJson(row, 4) != CanonicalOptionalJson(record, "result")
            || OptionalReaderJson(row, 5) != CanonicalOptionalJson(record, "error")
        )
            throw new InvalidDataException(
                "Legacy attempt-result conflicts with SQLite authority."
            );
    }

    private static string? OptionalReaderString(SqliteDataReader reader, int index) =>
        reader.IsDBNull(index) ? null : reader.GetString(index);

    private static int? OptionalReaderInt(SqliteDataReader reader, int index) =>
        reader.IsDBNull(index) ? null : reader.GetInt32(index);

    private static string? OptionalReaderJson(SqliteDataReader reader, int index) =>
        reader.IsDBNull(index) ? null : Codec.Write(Codec.Parse(reader.GetString(index)));

    private static string? CanonicalOptionalJson(JsonElement record, string name) =>
        record.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
            ? Codec.Write(Codec.Parse(value.GetRawText()))
            : null;

    private static string? OptionalString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.GetString()
            : null;

    private static int? OptionalInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.GetInt32()
            : null;

    private static string? RawArray(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.GetRawText()
            : null;

    private static string? RawJson(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null
            ? value.GetRawText()
            : null;

    private SqliteConnection Open()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText =
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON";
        command.ExecuteNonQuery();
        return connection;
    }

    private static void EnsureSchema(SqliteConnection connection)
    {
        using var schema = connection.BeginTransaction(deferred: false);
        using var command = connection.CreateCommand();
        command.Transaction = schema;
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS llm_journal_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS llm_journal_objects(object_id TEXT PRIMARY KEY,object_kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS llm_journal_requests(request_id TEXT PRIMARY KEY,session_id TEXT,purpose TEXT NOT NULL,iteration INTEGER NOT NULL,created_at INTEGER NOT NULL,prompt_object_id TEXT NOT NULL,tool_schema_object_id TEXT NOT NULL,requested_model_key TEXT NOT NULL,prompt_cache_key_hash TEXT NOT NULL,message_count INTEGER NOT NULL,checkpoint_message_ids_json TEXT,base_request_id TEXT,common_prefix_length INTEGER,appended_message_ids_json TEXT,delta_depth INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_llm_journal_requests_session_created ON llm_journal_requests(session_id,created_at,request_id);
            CREATE TABLE IF NOT EXISTS llm_journal_attempt_starts(event_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,attempt INTEGER NOT NULL,started_at INTEGER NOT NULL,concrete_model_id TEXT NOT NULL,virtual_model_key TEXT,provider_type TEXT NOT NULL,semantic_payload_sha256 TEXT NOT NULL,prompt_object_id TEXT);
            CREATE TABLE IF NOT EXISTS llm_journal_attempt_results(event_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,attempt INTEGER NOT NULL,completed_at INTEGER NOT NULL,outcome TEXT NOT NULL,result_json TEXT,error_json TEXT);
            CREATE TABLE IF NOT EXISTS llm_journal_import_state(source_path TEXT PRIMARY KEY,imported_size INTEGER NOT NULL,updated_at INTEGER NOT NULL);
            """;
        command.ExecuteNonQuery();
        using var columns = connection.CreateCommand();
        columns.Transaction = schema;
        columns.CommandText = "PRAGMA table_info(llm_journal_attempt_starts)";
        using var reader = columns.ExecuteReader();
        var hasPrompt = false;
        while (reader.Read())
            if (reader.GetString(1) == "prompt_object_id")
                hasPrompt = true;
        reader.Close();
        if (!hasPrompt)
        {
            using var alter = connection.CreateCommand();
            alter.Transaction = schema;
            alter.CommandText =
                "ALTER TABLE llm_journal_attempt_starts ADD COLUMN prompt_object_id TEXT";
            alter.ExecuteNonQuery();
        }
        schema.Commit();
    }

    private static string PutObject(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string kind,
        JsonNode value
    )
    {
        var payload = Codec.Write(value);
        var id = Sha256(kind + "\0" + payload);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "INSERT OR IGNORE INTO llm_journal_objects(object_id,object_kind,payload,created_at) VALUES($id,$kind,$payload,$created)";
        Add(command, "$id", id);
        Add(command, "$kind", kind);
        Add(command, "$payload", payload);
        Add(command, "$created", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        command.ExecuteNonQuery();
        return id;
    }

    private static (string RequestId, int Depth)? ReadLatestRequest(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string sessionId
    )
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText =
            "SELECT request_id,delta_depth FROM llm_journal_requests WHERE session_id=$session ORDER BY created_at DESC,rowid DESC LIMIT 1";
        Add(command, "$session", sessionId);
        using var reader = command.ExecuteReader();
        return reader.Read() ? (reader.GetString(0), reader.GetInt32(1)) : null;
    }

    private static List<string> ReconstructIds(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string requestId
    )
    {
        using var command = connection.CreateCommand();
        if (transaction is not null)
            command.Transaction = transaction;
        command.CommandText =
            "SELECT checkpoint_message_ids_json,base_request_id,common_prefix_length,appended_message_ids_json,delta_depth FROM llm_journal_requests WHERE request_id=$id";
        Add(command, "$id", requestId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            throw new InvalidDataException("Missing journal request.");
        var checkpoint = reader.IsDBNull(0)
            ? null
            : JsonSerializer.Deserialize<string[]>(reader.GetString(0));
        var depth = reader.GetInt32(4);
        if (depth < 0 || depth > MaxDeltaDepth)
            throw new InvalidDataException("Invalid journal delta depth.");
        if (checkpoint is not null)
        {
            if (depth != 0 || !reader.IsDBNull(1))
                throw new InvalidDataException("Invalid journal checkpoint manifest.");
            return checkpoint.ToList();
        }
        if (reader.IsDBNull(1) || depth == 0)
            throw new InvalidDataException("Invalid journal delta manifest.");
        var baseId = reader.GetString(1);
        var prefix = reader.IsDBNull(2) ? -1 : reader.GetInt32(2);
        var appended = reader.IsDBNull(3)
            ? throw new InvalidDataException("Journal delta is missing appended messages.")
            : JsonSerializer.Deserialize<string[]>(reader.GetString(3)) ?? [];
        var baseDepth = ReadScalar(
            connection,
            transaction,
            "SELECT delta_depth FROM llm_journal_requests WHERE request_id=$id",
            ("$id", baseId)
        );
        if (
            baseDepth is null
            || Convert.ToInt32(baseDepth, CultureInfo.InvariantCulture) != depth - 1
        )
            throw new InvalidDataException("Invalid journal delta ancestry.");
        var baseIds = ReconstructIds(connection, transaction, baseId);
        if (prefix < 0 || prefix > baseIds.Count)
            throw new InvalidDataException("Invalid journal common prefix.");
        return [.. baseIds.Take(prefix), .. appended];
    }

    private static JsonObject Reconstruct(SqliteConnection connection, string requestId)
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT session_id,purpose,iteration,created_at,prompt_object_id,tool_schema_object_id,requested_model_key,prompt_cache_key_hash,message_count FROM llm_journal_requests WHERE request_id=$id";
        Add(command, "$id", requestId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            return new JsonObject
            {
                ["requestId"] = requestId,
                ["completeness"] = "legacy-partial",
                ["missing"] = new JsonArray(
                    "request-manifest",
                    "system-prompt",
                    "tool-schema",
                    "canonical-messages"
                ),
            };
        var session = reader.IsDBNull(0) ? null : reader.GetString(0);
        var purpose = reader.GetString(1);
        var iteration = reader.GetInt32(2);
        var createdAt = reader.GetInt64(3);
        var promptId = reader.GetString(4);
        var schemaId = reader.GetString(5);
        var requested = reader.GetString(6);
        var cache = reader.GetString(7);
        var count = reader.GetInt32(8);
        reader.Close();
        var ids = ReconstructIds(connection, null, requestId);
        if (ids.Count != count)
            throw new InvalidDataException("Journal message count mismatch.");
        var systemPrompt = Codec.Parse(ReadObject(connection, promptId, "prompt"));
        var attempts = new JsonArray();
        var seenAttempts = new HashSet<int>();
        using (var starts = connection.CreateCommand())
        {
            starts.CommandText =
                "SELECT event_id,attempt,started_at,concrete_model_id,virtual_model_key,provider_type,semantic_payload_sha256,prompt_object_id FROM llm_journal_attempt_starts WHERE request_id=$id ORDER BY attempt,started_at";
            Add(starts, "$id", requestId);
            using var startReader = starts.ExecuteReader();
            while (startReader.Read())
            {
                var attempt = startReader.GetInt32(1);
                if (attempt < 1 || !seenAttempts.Add(attempt))
                    throw new InvalidDataException(
                        "Journal has duplicate or invalid attempt starts."
                    );
                using var resultCommand = connection.CreateCommand();
                resultCommand.CommandText =
                    "SELECT event_id,outcome,result_json,error_json,completed_at FROM llm_journal_attempt_results WHERE request_id=$id AND attempt=$attempt ORDER BY completed_at DESC LIMIT 1";
                Add(resultCommand, "$id", requestId);
                Add(resultCommand, "$attempt", attempt);
                using var resultReader = resultCommand.ExecuteReader();
                JsonObject? result = null;
                if (resultReader.Read())
                {
                    var outcome = resultReader.GetString(1);
                    if (outcome is not ("success" or "failure" or "abort"))
                        throw new InvalidDataException(
                            "Journal has an invalid attempt result outcome."
                        );
                    if (outcome == "success" && resultReader.IsDBNull(2))
                        throw new InvalidDataException(
                            "Journal success result is missing payload."
                        );
                    if (outcome != "success" && resultReader.IsDBNull(3))
                        throw new InvalidDataException("Journal failure result is missing error.");
                    result = new JsonObject
                    {
                        ["v"] = 1,
                        ["kind"] = "attempt-result",
                        ["eventId"] = resultReader.GetString(0),
                        ["requestId"] = requestId,
                        ["attempt"] = attempt,
                        ["completedAt"] = resultReader.GetInt64(4),
                        ["outcome"] = outcome,
                    };
                    if (!resultReader.IsDBNull(2))
                        result["result"] = Codec.Parse(resultReader.GetString(2));
                    if (!resultReader.IsDBNull(3))
                        result["error"] = Codec.Parse(resultReader.GetString(3));
                }
                var start = new JsonObject
                {
                    ["v"] = 1,
                    ["kind"] = "attempt-start",
                    ["eventId"] = startReader.GetString(0),
                    ["requestId"] = requestId,
                    ["attempt"] = attempt,
                    ["startedAt"] = startReader.GetInt64(2),
                    ["concreteModelId"] = startReader.GetString(3),
                    ["providerType"] = startReader.GetString(5),
                    ["semanticPayloadSha256"] = startReader.GetString(6),
                };
                if (!startReader.IsDBNull(4))
                    start["virtualModelKey"] = startReader.GetString(4);
                if (!startReader.IsDBNull(7))
                    start["promptObjectId"] = startReader.GetString(7);
                var attemptRecord = new JsonObject
                {
                    ["start"] = start,
                    ["systemPrompt"] = startReader.IsDBNull(7)
                        ? systemPrompt.DeepClone()
                        : Codec.Parse(ReadObject(connection, startReader.GetString(7), "prompt")),
                };
                if (result is not null)
                    attemptRecord["result"] = result;
                attempts.Add(attemptRecord);
            }
        }
        using (var results = connection.CreateCommand())
        {
            results.CommandText =
                "SELECT attempt,outcome FROM llm_journal_attempt_results WHERE request_id=$id";
            Add(results, "$id", requestId);
            using var resultReader = results.ExecuteReader();
            var seenResults = new HashSet<int>();
            while (resultReader.Read())
            {
                var attempt = resultReader.GetInt32(0);
                if (!seenAttempts.Contains(attempt) || !seenResults.Add(attempt))
                    throw new InvalidDataException(
                        "Journal has an orphaned or duplicate attempt result."
                    );
                if (resultReader.GetString(1) is not ("success" or "failure" or "abort"))
                    throw new InvalidDataException(
                        "Journal has an invalid attempt result outcome."
                    );
            }
        }
        return new JsonObject
        {
            ["requestId"] = requestId,
            ["completeness"] = "complete",
            ["sessionId"] = session,
            ["purpose"] = purpose,
            ["iteration"] = iteration,
            ["createdAt"] = createdAt,
            ["requestedModelKey"] = requested,
            ["promptCacheKeyHash"] = cache,
            ["systemPrompt"] = systemPrompt,
            ["toolDefinitions"] = Codec.Parse(ReadObject(connection, schemaId, "tool-schema")),
            ["messages"] = new JsonArray(
                ids.Select(id => Codec.Parse(ReadObject(connection, id, "message"))).ToArray()
            ),
            ["messageCount"] = count,
            ["attempts"] = attempts,
        };
    }

    private static string ReadObject(SqliteConnection connection, string id, string kind)
    {
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT object_kind,payload FROM llm_journal_objects WHERE object_id=$id";
        Add(command, "$id", id);
        using var reader = command.ExecuteReader();
        if (!reader.Read() || reader.GetString(0) != kind)
            throw new InvalidDataException("Invalid journal object reference.");
        var payload = reader.GetString(1);
        if (Sha256(kind + "\0" + payload) != id)
            throw new InvalidDataException("Journal object hash mismatch.");
        return payload;
    }

    private static JsonObject RequestJson(SqliteDataReader reader)
    {
        var result = new JsonObject
        {
            ["v"] = 1,
            ["kind"] = "request",
            ["requestId"] = reader.GetString(0),
            ["purpose"] = reader.GetString(2),
            ["iteration"] = reader.GetInt32(3),
            ["createdAt"] = reader.GetInt64(4),
            ["promptObjectId"] = reader.GetString(5),
            ["toolSchemaObjectId"] = reader.GetString(6),
            ["requestedModelKey"] = reader.GetString(7),
            ["promptCacheKeyHash"] = reader.GetString(8),
            ["messageCount"] = reader.GetInt32(9),
            ["deltaDepth"] = reader.GetInt32(14),
        };
        if (!reader.IsDBNull(1))
            result["sessionId"] = reader.GetString(1);
        if (!reader.IsDBNull(10))
            result["checkpointMessageObjectIds"] = Codec.Parse(reader.GetString(10));
        if (!reader.IsDBNull(11))
            result["baseRequestId"] = reader.GetString(11);
        if (!reader.IsDBNull(12))
            result["commonPrefixLength"] = reader.GetInt32(12);
        if (!reader.IsDBNull(13))
            result["appendedMessageObjectIds"] = Codec.Parse(reader.GetString(13));
        return result;
    }

    private static JsonObject AttemptStartJson(SqliteDataReader reader)
    {
        var result = new JsonObject
        {
            ["v"] = 1,
            ["kind"] = "attempt-start",
            ["eventId"] = reader.GetString(0),
            ["requestId"] = reader.GetString(1),
            ["attempt"] = reader.GetInt32(2),
            ["startedAt"] = reader.GetInt64(3),
            ["concreteModelId"] = reader.GetString(4),
            ["providerType"] = reader.GetString(6),
            ["semanticPayloadSha256"] = reader.GetString(7),
        };
        if (!reader.IsDBNull(5))
            result["virtualModelKey"] = reader.GetString(5);
        if (!reader.IsDBNull(8))
            result["promptObjectId"] = reader.GetString(8);
        return result;
    }

    private static JsonObject AttemptResultJson(SqliteDataReader reader)
    {
        var result = new JsonObject
        {
            ["v"] = 1,
            ["kind"] = "attempt-result",
            ["eventId"] = reader.GetString(0),
            ["requestId"] = reader.GetString(1),
            ["attempt"] = reader.GetInt32(2),
            ["completedAt"] = reader.GetInt64(3),
            ["outcome"] = reader.GetString(4),
        };
        if (!reader.IsDBNull(5))
            result["result"] = Codec.Parse(reader.GetString(5));
        if (!reader.IsDBNull(6))
            result["error"] = Codec.Parse(reader.GetString(6));
        return result;
    }

    private static JsonObject CanonicalMessage(JsonObject source)
    {
        var clone = (JsonObject)source.DeepClone();
        if (clone["role"]?.GetValue<string>() == "model")
        {
            var metadata = clone["__meta"] as JsonObject;
            clone.Remove("__meta");
            if (metadata?["modelId"] is JsonValue modelId)
                clone["__meta"] = new JsonObject { ["modelId"] = modelId.DeepClone() };
        }
        else
            clone.Remove("__meta");
        ConcreteRequestHistory.ProjectDisplayMetadata(clone);
        clone.Remove("modelVisible");
        return clone;
    }

    private static JsonObject ToSourceResult(ChatResult result)
    {
        var assistant = result.AssistantMessage;
        var parts = assistant?["parts"] as JsonArray;
        var text = string.Concat(
            parts
                ?.OfType<JsonObject>()
                .Where(part => part["text"] is JsonValue)
                .Select(part => part["text"]!.GetValue<string>())
                ?? []
        );
        var source = new JsonObject { ["text"] = text };
        if (result.TruncatedStopReason is string stopReason)
            source["truncatedStop"] = new JsonObject { ["stopReason"] = stopReason };
        var modelId = SessionWait.Text(assistant?["__meta"]?["modelId"]);
        if (modelId is not null)
            source["modelId"] = modelId;
        var virtualModelKey = SessionWait.Text(assistant?["__meta"]?["virtualModelKey"]);
        if (virtualModelKey is not null)
            source["virtualModelKey"] = virtualModelKey;
        if (result.JournalRequestId is not null)
            source["llmRequestId"] = result.JournalRequestId;
        if (result.JournalAttempt is not null)
            source["llmAttempt"] = result.JournalAttempt.Value;
        if (result.Usage is not null)
            source["usage"] = result.Usage.DeepClone();
        if (parts is not null)
            source["allParts"] = parts.DeepClone();
        var calls = parts
            ?.OfType<JsonObject>()
            .Select(part => part["functionCall"])
            .OfType<JsonObject>()
            .Select(call => call.DeepClone())
            .ToArray();
        if (calls is { Length: > 0 })
            source["toolCalls"] = new JsonArray(calls);
        if (assistant?["providerMeta"] is JsonObject providerMeta)
            source["providerMeta"] = providerMeta.DeepClone();
        if (assistant?["__meta"]?["llmRequestTiming"] is JsonObject timing)
            source["previousLlmRequest"] = timing.DeepClone();
        return source;
    }

    private static object? ReadScalar(
        SqliteConnection connection,
        SqliteTransaction? transaction,
        string sql,
        params (string Name, object? Value)[] values
    )
    {
        using var command = connection.CreateCommand();
        if (transaction is not null)
            command.Transaction = transaction;
        command.CommandText = sql;
        foreach (var value in values)
            Add(command, value.Name, value.Value);
        return command.ExecuteScalar();
    }

    private static string ObjectId(string kind, JsonNode value) =>
        Sha256(kind + "\0" + Codec.Write(value));

    private static string HashValue(JsonNode value) => Sha256(Codec.Write(value));

    private static string Sha256(string text) =>
        "sha256:"
        + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    private static void Add(SqliteCommand command, string name, object? value) =>
        command.Parameters.AddWithValue(name, value ?? DBNull.Value);

    private static class Codec
    {
        internal static string Write(JsonNode? value)
        {
            var builder = new StringBuilder();
            WriteValue(builder, value);
            return builder.ToString();
        }

        internal static JsonNode Parse(string text)
        {
            var parser = new Parser(text);
            var value = parser.Value();
            parser.SkipWhitespace();
            if (!parser.End)
                throw new InvalidDataException("Trailing data in journal JSON object.");
            return value ?? throw new InvalidDataException("Null journal JSON root.");
        }

        private static void WriteValue(StringBuilder builder, JsonNode? value)
        {
            if (value is null)
            {
                builder.Append("null");
                return;
            }
            if (value is JsonObject obj)
            {
                builder.Append('{');
                var first = true;
                foreach (var pair in Ordered(obj))
                {
                    if (!first)
                        builder.Append(',');
                    first = false;
                    WriteString(builder, pair.Key);
                    builder.Append(':');
                    WriteValue(builder, pair.Value);
                }
                builder.Append('}');
                return;
            }
            if (value is JsonArray array)
            {
                builder.Append('[');
                for (var i = 0; i < array.Count; i++)
                {
                    if (i > 0)
                        builder.Append(',');
                    WriteValue(builder, array[i]);
                }
                builder.Append(']');
                return;
            }
            var json = value.ToJsonString();
            if (value is JsonValue scalar && scalar.TryGetValue<string>(out var text))
            {
                WriteString(builder, text);
                return;
            }
            if (value is JsonValue number && number.TryGetValue<bool>(out var flag))
            {
                builder.Append(flag ? "true" : "false");
                return;
            }
            if (value is JsonValue numeric)
            {
                builder.Append(FormatNumber(numeric));
                return;
            }
            builder.Append(json);
        }

        private static string FormatNumber(JsonValue value)
        {
            if (
                value.TryGetValue<JsonElement>(out var element)
                && element.ValueKind == JsonValueKind.Number
            )
            {
                var raw = element.GetRawText();
                var number = element.GetDouble();
                ValidateRawNumber(raw, number);
                return EcmaNumber.Format(number);
            }
            if (value.TryGetValue<double>(out var doubleValue))
                return EcmaNumber.Format(doubleValue);
            if (value.TryGetValue<float>(out var floatValue))
                return EcmaNumber.Format(floatValue);
            if (value.TryGetValue<long>(out var signed))
                return FormatInteger(signed);
            if (value.TryGetValue<ulong>(out var unsigned))
                return FormatInteger(unsigned);
            if (value.TryGetValue<int>(out var integer))
                return FormatInteger(integer);
            if (value.TryGetValue<uint>(out var unsignedInteger))
                return FormatInteger(unsignedInteger);
            if (value.TryGetValue<short>(out var shortValue))
                return FormatInteger(shortValue);
            if (value.TryGetValue<ushort>(out var unsignedShort))
                return FormatInteger(unsignedShort);
            if (value.TryGetValue<byte>(out var byteValue))
                return FormatInteger(byteValue);
            if (value.TryGetValue<sbyte>(out var signedByte))
                return FormatInteger(signedByte);
            if (value.TryGetValue<decimal>(out _))
                throw new UnsupportedSessionAuthorityException(
                    "CLR decimal journal values are unsupported; use a finite binary64 number."
                );
            throw new InvalidDataException("Unsupported journal JSON number.");
        }

        private static string FormatInteger<T>(T value)
            where T : IBinaryInteger<T>
        {
            var integer = BigInteger.Parse(
                value.ToString(null, CultureInfo.InvariantCulture),
                CultureInfo.InvariantCulture
            );
            var number = (double)integer;
            if (!double.IsFinite(number) || new BigInteger(number) != integer)
                throw new UnsupportedSessionAuthorityException(
                    $"Journal integer {integer} is not exactly representable as an ECMAScript Number."
                );
            return EcmaNumber.Format(number);
        }

        private static void ValidateRawNumber(string raw, double number)
        {
            if (!double.IsFinite(number))
                throw new InvalidDataException(
                    "Journal JSON numbers must be finite binary64 values."
                );
            if (
                raw.IndexOfAny(['.', 'e', 'E']) < 0
                && BigInteger.TryParse(
                    raw,
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out var integer
                )
                && new BigInteger(number) != integer
            )
                throw new UnsupportedSessionAuthorityException(
                    $"Journal integer {raw} is not exactly representable as an ECMAScript Number."
                );
        }

        private static IEnumerable<KeyValuePair<string, JsonNode?>> Ordered(JsonObject obj) =>
            obj.OrderBy(pair => IsIndex(pair.Key) ? 0 : 1)
                .ThenBy(pair => IsIndex(pair.Key) ? Index(pair.Key) : uint.MaxValue)
                .ThenBy(pair => IsIndex(pair.Key) ? "" : pair.Key, StringComparer.Ordinal);

        private static bool IsIndex(string key) =>
            uint.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            && value != uint.MaxValue
            && value.ToString(CultureInfo.InvariantCulture) == key
            && !(key.Length > 1 && key[0] == '0');

        private static uint Index(string key) => uint.Parse(key, CultureInfo.InvariantCulture);

        private static void WriteString(StringBuilder builder, string value)
        {
            builder.Append('"');
            for (var i = 0; i < value.Length; i++)
            {
                var ch = value[i];
                if (ch == '"')
                    builder.Append("\\\"");
                else if (ch == '\\')
                    builder.Append("\\\\");
                else if (ch == '\b')
                    builder.Append("\\b");
                else if (ch == '\f')
                    builder.Append("\\f");
                else if (ch == '\n')
                    builder.Append("\\n");
                else if (ch == '\r')
                    builder.Append("\\r");
                else if (ch == '\t')
                    builder.Append("\\t");
                else if (ch < 0x20)
                    builder
                        .Append("\\u")
                        .Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                else if (
                    char.IsHighSurrogate(ch)
                    && i + 1 < value.Length
                    && char.IsLowSurrogate(value[i + 1])
                )
                {
                    builder.Append(ch).Append(value[++i]);
                }
                else if (char.IsSurrogate(ch))
                    builder
                        .Append("\\u")
                        .Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                else
                    builder.Append(ch);
            }
            builder.Append('"');
        }

        private sealed class Parser(string text)
        {
            private int offset;
            internal bool End => offset >= text.Length;

            internal void SkipWhitespace()
            {
                while (!End && text[offset] is ' ' or '\n' or '\r' or '\t')
                    offset++;
            }

            internal JsonNode? Value()
            {
                SkipWhitespace();
                if (End)
                    throw new InvalidDataException("Unexpected end of journal JSON.");
                return text[offset] switch
                {
                    '{' => Object(),
                    '[' => Array(),
                    '"' => JsonValue.Create(String()),
                    't' => Literal("true", JsonValue.Create(true)),
                    'f' => Literal("false", JsonValue.Create(false)),
                    'n' => Literal("null", null),
                    _ => Number(),
                };
            }

            private JsonNode Object()
            {
                offset++;
                var result = new JsonObject();
                SkipWhitespace();
                if (!Consume('}'))
                {
                    while (true)
                    {
                        SkipWhitespace();
                        if (End || text[offset] != '"')
                            throw new InvalidDataException("Invalid journal JSON object key.");
                        var key = String();
                        SkipWhitespace();
                        Expect(':');
                        result[key] = Value();
                        SkipWhitespace();
                        if (Consume('}'))
                            break;
                        Expect(',');
                    }
                }
                return result;
            }

            private JsonNode Array()
            {
                offset++;
                var result = new JsonArray();
                SkipWhitespace();
                if (!Consume(']'))
                {
                    while (true)
                    {
                        result.Add(Value());
                        SkipWhitespace();
                        if (Consume(']'))
                            break;
                        Expect(',');
                    }
                }
                return result;
            }

            private JsonNode? Literal(string literal, JsonNode? value)
            {
                if (
                    offset + literal.Length > text.Length
                    || !text.AsSpan(offset, literal.Length).SequenceEqual(literal)
                )
                    throw new InvalidDataException("Invalid journal JSON literal.");
                offset += literal.Length;
                return value;
            }

            private JsonNode Number()
            {
                var start = offset;
                if (Consume('-')) { }
                if (End)
                    throw new InvalidDataException("Invalid journal JSON number.");
                if (Consume('0'))
                {
                    if (!End && char.IsDigit(text[offset]))
                        throw new InvalidDataException("Invalid journal JSON number.");
                }
                else
                {
                    if (End || text[offset] is < '1' or > '9')
                        throw new InvalidDataException("Invalid journal JSON number.");
                    while (!End && char.IsDigit(text[offset]))
                        offset++;
                }
                if (Consume('.'))
                {
                    if (End || !char.IsDigit(text[offset]))
                        throw new InvalidDataException("Invalid journal JSON number.");
                    while (!End && char.IsDigit(text[offset]))
                        offset++;
                }
                if (!End && text[offset] is 'e' or 'E')
                {
                    offset++;
                    if (!End && text[offset] is '+' or '-')
                        offset++;
                    if (End || !char.IsDigit(text[offset]))
                        throw new InvalidDataException("Invalid journal JSON number.");
                    while (!End && char.IsDigit(text[offset]))
                        offset++;
                }
                if (
                    !End
                    && text[offset]
                        is not ','
                            and not ']'
                            and not '}'
                            and not ' '
                            and not '\n'
                            and not '\r'
                            and not '\t'
                )
                    throw new InvalidDataException("Invalid journal JSON number.");
                var raw = text[start..offset];
                if (
                    !double.TryParse(
                        raw,
                        NumberStyles.Float,
                        CultureInfo.InvariantCulture,
                        out var value
                    ) || !double.IsFinite(value)
                )
                    throw new InvalidDataException("Invalid journal JSON number.");
                ValidateRawNumber(raw, value);
                return JsonValue.Create(value)!;
            }

            private string String()
            {
                Expect('"');
                var result = new StringBuilder();
                while (!End)
                {
                    var ch = text[offset++];
                    if (ch == '"')
                        return result.ToString();
                    if (ch != '\\')
                    {
                        if (ch < 0x20)
                            throw new InvalidDataException(
                                "Invalid control character in journal JSON string."
                            );
                        result.Append(ch);
                        continue;
                    }
                    if (End)
                        throw new InvalidDataException("Unterminated journal JSON escape.");
                    switch (text[offset++])
                    {
                        case '"':
                            result.Append('"');
                            break;
                        case '\\':
                            result.Append('\\');
                            break;
                        case '/':
                            result.Append('/');
                            break;
                        case 'b':
                            result.Append('\b');
                            break;
                        case 'f':
                            result.Append('\f');
                            break;
                        case 'n':
                            result.Append('\n');
                            break;
                        case 'r':
                            result.Append('\r');
                            break;
                        case 't':
                            result.Append('\t');
                            break;
                        case 'u':
                            if (
                                offset + 4 > text.Length
                                || !ushort.TryParse(
                                    text.AsSpan(offset, 4),
                                    NumberStyles.AllowHexSpecifier,
                                    CultureInfo.InvariantCulture,
                                    out var code
                                )
                            )
                                throw new InvalidDataException(
                                    "Invalid journal JSON Unicode escape."
                                );
                            result.Append((char)code);
                            offset += 4;
                            break;
                        default:
                            throw new InvalidDataException("Invalid journal JSON escape.");
                    }
                }
                throw new InvalidDataException("Unterminated journal JSON string.");
            }

            private bool Consume(char value)
            {
                if (!End && text[offset] == value)
                {
                    offset++;
                    return true;
                }
                return false;
            }

            private void Expect(char value)
            {
                if (!Consume(value))
                    throw new InvalidDataException($"Expected '{value}' in journal JSON.");
            }
        }
    }
}
