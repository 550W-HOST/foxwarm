namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The journal's part of <c>foxwarm hosted import</c>. The import copies the file journal's
/// rows unchanged (they are the same tables); the one table the file journal doesn't have,
/// <c>llm_journal_request_objects</c>, is derived here from the stored request rows with the
/// rule <see cref="EnqueueRequestAsync"/> applies when it writes a request, so retention sees
/// the same references as for a request written in hosted mode.
/// </summary>
internal sealed partial class PgLlmJournalStore
{
    /// <summary>
    /// The objects a stored request names itself: its prompt and tool schema, and the message
    /// IDs of its manifest (all of them for a checkpoint, the appended ones for a delta, whose
    /// prefix stays named by its base).
    /// </summary>
    internal static string[] RequestObjects(
        string promptObjectId,
        string toolSchemaObjectId,
        string? checkpointMessageIdsJson,
        string? appendedMessageIdsJson
    )
    {
        var listed = checkpointMessageIdsJson is not null
            ? JsonData.Deserialize<string[]>(checkpointMessageIdsJson)
            : appendedMessageIdsJson is not null
                ? JsonData.Deserialize<string[]>(appendedMessageIdsJson)
                : [];
        return new[] { promptObjectId, toolSchemaObjectId }
            .Concat(listed ?? [])
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    /// <summary>Writes the derived reference rows of imported requests in one statement.</summary>
    internal static int ImportRequestObjects(PgTx tx, IReadOnlyList<(string RequestId, string[] Objects)> requests) =>
        tx.Execute(
            "INSERT INTO llm_journal_request_objects(request_id,object_id)"
                + " SELECT r, o FROM unnest($1::text[], $2::text[]) AS t(r, o) ON CONFLICT DO NOTHING",
            requests.SelectMany(request => request.Objects.Select(_ => request.RequestId)).ToArray(),
            requests.SelectMany(request => request.Objects).ToArray()
        );
}
