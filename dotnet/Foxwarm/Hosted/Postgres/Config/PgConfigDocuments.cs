using System.Security.Cryptography;
using System.Text;
using Foxwarm.Storage;
using Foxwarm.Tools;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// <see cref="IConfigDocumentStore"/> in the <c>config_documents</c> table: one row per document
/// name with its text verbatim. A document is absent exactly when it has no row. A replacement
/// is one fenced upsert, so a reader sees the previous text or the new one; there is no torn
/// write to guard against. Nothing edits a row outside the owner's installations, so
/// <see cref="DirectEdits"/> is false and owners cache a document until they install it.
/// </summary>
internal sealed class PgConfigDocuments(TenantDb database, string? writer = null)
    : IConfigDocumentStore
{
    private static readonly UTF8Encoding Strict = new(false, true);

    internal static string Key(ConfigDocumentName name) =>
        name switch
        {
            ConfigDocumentName.Config => "config",
            ConfigDocumentName.Models => "models",
            ConfigDocumentName.ToolAuthorization => "tool-authorization",
            ConfigDocumentName.Mcp => "mcp",
            ConfigDocumentName.WebUi => "webui",
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };

    public bool DirectEdits => false;

    public string Locator(ConfigDocumentName name) => "config_documents/" + Key(name);

    public string? PhysicalPath(ConfigDocumentName name)
    {
        _ = Key(name);
        return null;
    }

    public bool Exists(ConfigDocumentName name)
    {
        var key = Key(name);
        return database.Read(tx =>
            tx.Scalar("SELECT 1 FROM config_documents WHERE name = $1", key) is not null
        );
    }

    public byte[]? Read(ConfigDocumentName name)
    {
        var key = Key(name);
        return database.Read(tx =>
                tx.Scalar("SELECT text FROM config_documents WHERE name = $1", key) as string
            ) is { } text
            ? Strict.GetBytes(text)
            : null;
    }

    // One statement returns the size and, only within the limit, the text.
    public byte[]? ReadBounded(ConfigDocumentName name, int maxBytes)
    {
        var key = Key(name);
        var (found, size, text) = database.Read(tx =>
        {
            using var command = tx.Command(
                "SELECT octet_length(text), CASE WHEN octet_length(text) <= $2 THEN text END"
                    + " FROM config_documents WHERE name = $1",
                key,
                maxBytes
            );
            using var reader = command.ExecuteReader();
            if (!reader.Read())
                return (false, 0, (string?)null);
            return (true, reader.GetInt32(0), reader.IsDBNull(1) ? null : reader.GetString(1));
        });
        if (!found)
            return null;
        if (size > maxBytes || text is null)
            throw new InvalidDataException("Tool policy exceeds its byte limit.");
        var bytes = Strict.GetBytes(text);
        return bytes.Length > maxBytes
            ? throw new InvalidDataException("Tool policy exceeds its byte limit.")
            : bytes;
    }

    public async Task ReplaceAsync(
        ConfigDocumentName name,
        byte[] bytes,
        CancellationToken token,
        Action<AtomicJsonWriteStage>? stage = null
    )
    {
        var key = Key(name);
        var text = Text(name, bytes);
        var sha = SHA256.HashData(bytes);
        stage?.Invoke(AtomicJsonWriteStage.BeforeTempWrite);
        stage?.Invoke(AtomicJsonWriteStage.BeforeRename);
        long written = 0;
        await database
            .WriteAsync(
                async (tx, cancel) =>
                {
                    await using var command = tx.Command(
                        "INSERT INTO config_documents (name, text, sha256, updated_by)"
                            + " VALUES ($1, $2, $3, $4)"
                            + " ON CONFLICT (tenant_id, name) DO UPDATE SET text = excluded.text,"
                            + " sha256 = excluded.sha256, updated_by = excluded.updated_by,"
                            + " generation = config_documents.generation + 1, updated_at = now()"
                            + " RETURNING generation",
                        key,
                        text,
                        sha,
                        writer
                    );
                    written = (long)(await command.ExecuteScalarAsync(cancel).ConfigureAwait(false))!;
                    return written;
                },
                new PgWriteOptions(Verify: tx => Written(tx, key, written, sha)),
                token
            )
            .ConfigureAwait(false);
    }

    public async Task<bool> TryCreateAsync(
        ConfigDocumentName name,
        byte[] bytes,
        CancellationToken token
    )
    {
        var key = Key(name);
        var text = Text(name, bytes);
        var sha = SHA256.HashData(bytes);
        return await database
            .WriteAsync(
                async (tx, cancel) =>
                {
                    await using var command = tx.Command(
                        "INSERT INTO config_documents (name, text, sha256, updated_by)"
                            + " VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, name) DO NOTHING"
                            + " RETURNING generation",
                        key,
                        text,
                        sha,
                        writer
                    );
                    return await command.ExecuteScalarAsync(cancel).ConfigureAwait(false)
                        is not null;
                },
                new PgWriteOptions(Verify: tx => Written(tx, key, 1, sha)),
                token
            )
            .ConfigureAwait(false);
    }

    private static bool Written(PgTx tx, string key, long generation, byte[] sha) =>
        tx.Scalar(
            "SELECT 1 FROM config_documents WHERE name = $1 AND generation = $2 AND sha256 = $3",
            key,
            generation,
            sha
        )
            is not null;

    // A document is text: UTF-8 without NUL, which a text column can't hold. The policy keeps
    // its byte limit here too, whatever the caller validated.
    private static string Text(ConfigDocumentName name, byte[] bytes)
    {
        if (
            name == ConfigDocumentName.ToolAuthorization
            && bytes.Length > ToolAuthorizationPolicy.MaxBytes
        )
            throw new InvalidDataException("Tool policy exceeds its byte limit.");
        string text;
        try
        {
            text = Strict.GetString(bytes);
        }
        catch (DecoderFallbackException error)
        {
            throw new InvalidDataException("Configuration documents must be UTF-8 text.", error);
        }
        return text.Contains('\0')
            ? throw new InvalidDataException("Configuration documents can't contain NUL characters.")
            : text;
    }
}
