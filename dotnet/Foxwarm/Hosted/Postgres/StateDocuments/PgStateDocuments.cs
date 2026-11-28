using System.Text.Json.Nodes;
using Foxwarm.Storage;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// <see cref="IStateDocuments"/> in the <c>state_documents</c> table: one row per document
/// name with its text verbatim. A replacement is one fenced upsert, so a reader sees the
/// previous text or the new one and never a torn write; that is why there are no retained
/// earlier versions (<see cref="IStateDocument.ReadFirstAvailable{T}"/> reads only the current
/// one) and nothing to make durable after a commit. A document is absent exactly when it has
/// no row, which also covers the file implementation's parent-directory rules. Writing the
/// Installation document raises the tenant's minimum reader version with it.
/// </summary>
internal sealed class PgStateDocuments(TenantDb database) : IStateDocuments
{
    public IStateDocument Open(StateDocumentName name, StateDocumentOptions? options = null) =>
        Enum.IsDefined(name)
            ? new Document(database, name)
            : throw new ArgumentOutOfRangeException(nameof(name));

    internal static string Key(StateDocumentName name) =>
        name switch
        {
            StateDocumentName.Timers => "timers",
            StateDocumentName.RunningExec => "running-exec",
            StateDocumentName.Channels => "channels",
            StateDocumentName.ChannelCursors => "channel-cursors",
            StateDocumentName.Nodes => "nodes",
            StateDocumentName.McpOAuth => "mcp-oauth",
            StateDocumentName.Agents => "agents",
            StateDocumentName.Installation => "installation",
            StateDocumentName.Secrets => "secrets",
            StateDocumentName.SecretExposures => "secret-exposures",
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

    private sealed class Document(TenantDb database, StateDocumentName name) : IStateDocument
    {
        private readonly string key = Key(name);

        public string Locator => "state_documents/" + key;

        public bool Exists() =>
            database.Read(tx =>
                tx.Scalar("SELECT 1 FROM state_documents WHERE name = $1", key) is not null
            );

        public string? ReadText() =>
            database.Read(tx =>
                tx.Scalar("SELECT text FROM state_documents WHERE name = $1", key) as string
            );

        public Task<string?> ReadTextAsync(CancellationToken token = default) =>
            database.ReadAsync(
                async (tx, cancel) =>
                {
                    await using var command = tx.Command(
                        "SELECT text FROM state_documents WHERE name = $1",
                        key
                    );
                    return await command.ExecuteScalarAsync(cancel).ConfigureAwait(false) as string;
                },
                token: token
            );

        public T? ReadFirstAvailable<T>(Func<string, T> parse, out string? source)
            where T : class
        {
            source = null;
            if (ReadText() is not { } text)
                return null;
            var value = parse(text);
            source = Locator;
            return value;
        }

        public void ReplaceText(string text, CancellationToken token = default)
        {
            ArgumentNullException.ThrowIfNull(text);
            token.ThrowIfCancellationRequested();
            long written = 0;
            database.Write(
                tx =>
                {
                    written = (long)tx.Scalar(
                        "INSERT INTO state_documents (name, text) VALUES ($1, $2)"
                            + " ON CONFLICT (tenant_id, name) DO UPDATE SET text = excluded.text,"
                            + " generation = state_documents.generation + 1, updated_at = now()"
                            + " RETURNING generation",
                        key,
                        text
                    )!;
                    if (name == StateDocumentName.Installation && MinimumReaderVersion(text) is { } level)
                        tx.Scalar("SELECT foxwarm_raise_reader_version($1)", level);
                    return written;
                },
                new PgWriteOptions(
                    Verify: tx =>
                        tx.Scalar(
                            "SELECT 1 FROM state_documents WHERE name = $1 AND generation = $2 AND text = $3",
                            key,
                            written,
                            text
                        )
                            is not null
                )
            );
        }

        public void EnsureDurable() { }

        private static int? MinimumReaderVersion(string text)
        {
            try
            {
                return JsonNode.Parse(text) is JsonObject document
                    && document["minimumReaderVersion"] is JsonValue value
                    && value.TryGetValue<int>(out var level)
                    && level >= 1
                    ? level
                    : null;
            }
            catch (System.Text.Json.JsonException)
            {
                return null;
            }
        }
    }
}
