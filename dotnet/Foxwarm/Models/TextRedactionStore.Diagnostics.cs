using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Secrets;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Models;

internal sealed partial class TextRedactionStore
{
    // Does not construct InstanceSecrets, a redactor with a store, or the writable cache.
    // A missing, incompatible or unreadable store is an error, never repaired here.
    internal static JsonObject KnownStatistics(string dataRoot, string? storePath = null)
    {
        var keys = InstanceKeys.Read(InstanceKeys.DefaultPath(dataRoot));
        var key = keys.Derive(InstanceKeys.TextRedactionStorePurpose, 64);
        using var shape = new TextRedactor(
            keys.Derive(InstanceKeys.TextRedactionPlaceholderPurpose)
        );
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = storePath is null
                    ? Path.Combine(Path.GetFullPath(dataRoot), "state", FileName)
                    : Path.GetFullPath(storePath),
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        using var transaction = connection.BeginTransaction(deferred: true);
        using (var check = connection.CreateCommand())
        {
            check.Transaction = transaction;
            check.CommandText = "SELECT value FROM meta WHERE key='check'";
            var expected = HMACSHA256.HashData(
                key[32..64],
                Encoding.ASCII.GetBytes("check\0" + FormatVersion + "\0")
            )[..IdBytes];
            if (check.ExecuteScalar() is not byte[] stored || !stored.SequenceEqual(expected))
                throw new InvalidDataException(
                    "Text redaction store key or format does not match."
                );
        }
        var encryptionKey = key[..32];
        long total = 0,
            readable = 0,
            unreadable = 0,
            digits = 0,
            dash = 0,
            identifiers = 0,
            placeholders = 0,
            eligible = 0;
        var labels = new SortedDictionary<string, long>(StringComparer.Ordinal);
        var lengths = new JsonObject
        {
            ["1"] = 0L,
            ["2-3"] = 0L,
            ["4-7"] = 0L,
            ["8-15"] = 0L,
            ["16-31"] = 0L,
            ["32-63"] = 0L,
            ["64+"] = 0L,
        };
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT id, data FROM known";
        using var rows = command.ExecuteReader();
        while (rows.Read())
        {
            total++;
            var payload = Unseal(encryptionKey, true, [], (byte[])rows[0], (byte[])rows[1]);
            if (payload is null || Known(payload) is not { } known)
            {
                unreadable++;
                continue;
            }
            readable++;
            var (original, categories) = known;
            if (TextRedactionKnownLabels.Default.Allows(categories))
                eligible++;
            foreach (var label in categories.Distinct(StringComparer.Ordinal))
                labels[label] = labels.GetValueOrDefault(label) + 1;
            var bucket = original.Length switch
            {
                1 => "1",
                <= 3 => "2-3",
                <= 7 => "4-7",
                <= 15 => "8-15",
                <= 31 => "16-31",
                <= 63 => "32-63",
                _ => "64+",
            };
            lengths[bucket] = lengths[bucket]!.GetValue<long>() + 1;
            if (original.EnumerateRunes().All(Rune.IsDigit))
                digits++;
            if (original.StartsWith('-'))
                dash++;
            if (
                (char.IsAsciiLetter(original[0]) || original[0] == '_')
                && original.All(character =>
                    char.IsAsciiLetterOrDigit(character) || character == '_'
                )
            )
                identifiers++;
            if (shape.ContainsPlaceholder(original))
                placeholders++;
        }
        var byLabel = new JsonObject();
        foreach (var (label, count) in labels)
            byLabel[label] = count;
        return new JsonObject
        {
            ["count"] = total,
            ["readable"] = readable,
            ["unreadable"] = unreadable,
            ["byLabel"] = byLabel,
            ["lengthUtf16"] = lengths,
            ["allDigits"] = digits,
            ["startsWithDash"] = dash,
            ["asciiIdentifiers"] = identifiers,
            ["containsPlaceholder"] = placeholders,
            ["defaultKnownLabelsEligible"] = eligible,
            ["defaultKnownLabelsIneligible"] = readable - eligible,
        };
    }
}
