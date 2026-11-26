using System.Text.Json.Nodes;

namespace Foxwarm.Models;

/// <summary>The manifest columns of one journal request that its message list derives from.</summary>
internal sealed record LlmJournalManifest(
    string? CheckpointMessageIdsJson,
    string? BaseRequestId,
    int? CommonPrefixLength,
    string? AppendedMessageIdsJson,
    int DeltaDepth
);

/// <summary>The descriptive columns of one journal request.</summary>
internal sealed record LlmJournalHeader(
    string? SessionId,
    string Purpose,
    int Iteration,
    long CreatedAt,
    string PromptObjectId,
    string ToolSchemaObjectId,
    string RequestedModelKey,
    string PromptCacheKeyHash,
    int MessageCount
);

internal sealed record LlmJournalStartRow(
    string EventId,
    int Attempt,
    long StartedAt,
    string ConcreteModelId,
    string? VirtualModelKey,
    string ProviderType,
    string SemanticPayloadSha256,
    string? PromptObjectId
);

internal sealed record LlmJournalResultRow(
    string EventId,
    string Outcome,
    string? ResultJson,
    string? ErrorJson,
    long CompletedAt
);

/// <summary>
/// The journal rows reconstruction reads, one query each, so every journal backend validates
/// and assembles a request with the same code.
/// </summary>
internal interface ILlmJournalRows
{
    LlmJournalManifest? Manifest(string requestId);

    LlmJournalHeader? Header(string requestId);

    /// <summary>The request's attempt starts ordered by attempt, then start time.</summary>
    IReadOnlyList<LlmJournalStartRow> Starts(string requestId);

    /// <summary>The attempt's result with the latest completion time, or null.</summary>
    LlmJournalResultRow? LatestResult(string requestId, int attempt);

    /// <summary>Every result of the request with its outcome.</summary>
    IReadOnlyList<(int Attempt, string Outcome)> Outcomes(string requestId);

    (string Kind, string Payload)? Object(string objectId);
}

/// <summary>
/// Request reconstruction and delta manifests over <see cref="ILlmJournalRows"/>: the message
/// identity list of a request, the assembled request with its attempts, and the manifest of a
/// newly admitted request relative to its Session's latest one.
/// </summary>
internal static class LlmJournalReconstruction
{
    internal const int MaxDeltaDepth = 8;

    /// <summary>What a new request stores to describe its messages.</summary>
    internal sealed record DeltaPlan(
        string? BaseRequestId,
        int? CommonPrefixLength,
        int DeltaDepth,
        string? CheckpointJson,
        string? AppendedJson
    );

    /// <summary>
    /// A delta against the Session's latest request while its chain is shorter than
    /// <see cref="MaxDeltaDepth"/>, otherwise a checkpoint of every message identity.
    /// </summary>
    internal static DeltaPlan PlanDelta(
        ILlmJournalRows rows,
        (string RequestId, int Depth)? prior,
        string[] messageIds
    )
    {
        string? baseRequest = null;
        int? commonPrefix = null;
        var deltaDepth = 0;
        if (prior is not null && prior.Value.Depth < MaxDeltaDepth)
        {
            var priorIds = ReconstructIds(rows, prior.Value.RequestId);
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
        var checkpoint = baseRequest is null ? JsonData.Serialize(messageIds) : null;
        var appended = baseRequest is null
            ? null
            : JsonData.Serialize(messageIds[(commonPrefix ?? 0)..]);
        return new(baseRequest, commonPrefix, deltaDepth, checkpoint, appended);
    }

    internal static List<string> ReconstructIds(ILlmJournalRows rows, string requestId)
    {
        var manifest =
            rows.Manifest(requestId) ?? throw new InvalidDataException("Missing journal request.");
        var checkpoint = manifest.CheckpointMessageIdsJson is null
            ? null
            : JsonData.Deserialize<string[]>(manifest.CheckpointMessageIdsJson);
        var depth = manifest.DeltaDepth;
        if (depth < 0 || depth > MaxDeltaDepth)
            throw new InvalidDataException("Invalid journal delta depth.");
        if (checkpoint is not null)
        {
            if (depth != 0 || manifest.BaseRequestId is not null)
                throw new InvalidDataException("Invalid journal checkpoint manifest.");
            return checkpoint.ToList();
        }
        if (manifest.BaseRequestId is null || depth == 0)
            throw new InvalidDataException("Invalid journal delta manifest.");
        var baseId = manifest.BaseRequestId;
        var prefix = manifest.CommonPrefixLength ?? -1;
        var appended = manifest.AppendedMessageIdsJson is null
            ? throw new InvalidDataException("Journal delta is missing appended messages.")
            : JsonData.Deserialize<string[]>(manifest.AppendedMessageIdsJson) ?? [];
        var baseDepth = rows.Manifest(baseId)?.DeltaDepth;
        if (baseDepth is null || baseDepth != depth - 1)
            throw new InvalidDataException("Invalid journal delta ancestry.");
        var baseIds = ReconstructIds(rows, baseId);
        if (prefix < 0 || prefix > baseIds.Count)
            throw new InvalidDataException("Invalid journal common prefix.");
        return [.. baseIds.Take(prefix), .. appended];
    }

    /// <summary>
    /// The complete request with its attempts. A missing manifest is reported as a legacy
    /// partial request; any inconsistency throws <see cref="InvalidDataException"/>.
    /// </summary>
    internal static JsonObject Reconstruct(ILlmJournalRows rows, string requestId)
    {
        var header = rows.Header(requestId);
        if (header is null)
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
        var ids = ReconstructIds(rows, requestId);
        if (ids.Count != header.MessageCount)
            throw new InvalidDataException("Journal message count mismatch.");
        var systemPrompt = LlmRequestJournalStore.Codec.Parse(
            ReadObject(rows, header.PromptObjectId, "prompt")
        );
        var attempts = new JsonArray();
        var seenAttempts = new HashSet<int>();
        foreach (var row in rows.Starts(requestId))
        {
            var attempt = row.Attempt;
            if (attempt < 1 || !seenAttempts.Add(attempt))
                throw new InvalidDataException("Journal has duplicate or invalid attempt starts.");
            JsonObject? result = null;
            if (rows.LatestResult(requestId, attempt) is { } found)
            {
                var outcome = found.Outcome;
                if (outcome is not ("success" or "failure" or "abort"))
                    throw new InvalidDataException("Journal has an invalid attempt result outcome.");
                if (outcome == "success" && found.ResultJson is null)
                    throw new InvalidDataException("Journal success result is missing payload.");
                if (outcome != "success" && found.ErrorJson is null)
                    throw new InvalidDataException("Journal failure result is missing error.");
                result = new JsonObject
                {
                    ["v"] = 1,
                    ["kind"] = "attempt-result",
                    ["eventId"] = found.EventId,
                    ["requestId"] = requestId,
                    ["attempt"] = attempt,
                    ["completedAt"] = found.CompletedAt,
                    ["outcome"] = outcome,
                };
                if (found.ResultJson is not null)
                    result["result"] = LlmRequestJournalStore.Codec.Parse(found.ResultJson);
                if (found.ErrorJson is not null)
                    result["error"] = LlmRequestJournalStore.Codec.Parse(found.ErrorJson);
            }
            var start = new JsonObject
            {
                ["v"] = 1,
                ["kind"] = "attempt-start",
                ["eventId"] = row.EventId,
                ["requestId"] = requestId,
                ["attempt"] = attempt,
                ["startedAt"] = row.StartedAt,
                ["concreteModelId"] = row.ConcreteModelId,
                ["providerType"] = row.ProviderType,
                ["semanticPayloadSha256"] = row.SemanticPayloadSha256,
            };
            if (row.VirtualModelKey is not null)
                start["virtualModelKey"] = row.VirtualModelKey;
            if (row.PromptObjectId is not null)
                start["promptObjectId"] = row.PromptObjectId;
            var attemptRecord = new JsonObject
            {
                ["start"] = start,
                ["systemPrompt"] = row.PromptObjectId is null
                    ? systemPrompt.DeepClone()
                    : LlmRequestJournalStore.Codec.Parse(
                        ReadObject(rows, row.PromptObjectId, "prompt")
                    ),
            };
            if (result is not null)
                attemptRecord["result"] = result;
            attempts.Add(attemptRecord);
        }
        var seenResults = new HashSet<int>();
        foreach (var (attempt, outcome) in rows.Outcomes(requestId))
        {
            if (!seenAttempts.Contains(attempt) || !seenResults.Add(attempt))
                throw new InvalidDataException(
                    "Journal has an orphaned or duplicate attempt result."
                );
            if (outcome is not ("success" or "failure" or "abort"))
                throw new InvalidDataException("Journal has an invalid attempt result outcome.");
        }
        return new JsonObject
        {
            ["requestId"] = requestId,
            ["completeness"] = "complete",
            ["sessionId"] = header.SessionId,
            ["purpose"] = header.Purpose,
            ["iteration"] = header.Iteration,
            ["createdAt"] = header.CreatedAt,
            ["requestedModelKey"] = header.RequestedModelKey,
            ["promptCacheKeyHash"] = header.PromptCacheKeyHash,
            ["systemPrompt"] = systemPrompt,
            ["toolDefinitions"] = LlmRequestJournalStore.Codec.Parse(
                ReadObject(rows, header.ToolSchemaObjectId, "tool-schema")
            ),
            ["messages"] = new JsonArray(
                ids.Select(id => LlmRequestJournalStore.Codec.Parse(ReadObject(rows, id, "message")))
                    .ToArray()
            ),
            ["messageCount"] = header.MessageCount,
            ["attempts"] = attempts,
        };
    }

    /// <summary>The payload of a referenced object, checked against its kind and hash.</summary>
    internal static string ReadObject(ILlmJournalRows rows, string id, string kind)
    {
        if (rows.Object(id) is not { } found || found.Kind != kind)
            throw new InvalidDataException("Invalid journal object reference.");
        if (LlmRequestJournalStore.Sha256(kind + "\0" + found.Payload) != id)
            throw new InvalidDataException("Journal object hash mismatch.");
        return found.Payload;
    }
}
