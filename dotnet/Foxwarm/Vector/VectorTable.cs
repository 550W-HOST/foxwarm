using System.Text.Json;
using System.Text.Json.Nodes;
using Apache.Arrow;
using Apache.Arrow.Types;
using lancedb;

namespace Foxwarm.Vector;

// Only an enabled owner constructs this type. Disabled Main never loads the native engine.
internal sealed class VectorTable : IDisposable
{
    internal static readonly string[] Columns =
        "id,message_id,session_id,agent,memory_kind,seq,start_seq,end_seq,raw_start_seq,raw_end_seq,message_count,role,timestamp,start_timestamp,end_timestamp,chunk_index,chunk_count,text,chunk_text,block_id,block_level,source_kind,source_start,source_end,vector".Split(
            ','
        );
    private static readonly HashSet<string> Strings = new(
        "id,message_id,session_id,agent,memory_kind,role,text,chunk_text,source_kind".Split(',')
    );
    private static readonly Field VectorItem = new("item", FloatType.Default, true);
    internal static readonly Schema Schema = new(
        Columns.Select(name => new Field(
            name,
            name == "vector" ? new FixedSizeListType(VectorItem, 1024)
                : Strings.Contains(name) ? StringType.Default
                : DoubleType.Default,
            true
        )),
        null
    );
    private readonly Connection connection = new();
    private lancedb.Table table = null!;
    internal Action? MutationCompleted { get; set; }

    internal async Task OpenAsync(string path)
    {
        Directory.CreateDirectory(path);
        await connection.Connect(path);
        if ((await connection.TableNames()).Contains("messages_v7", StringComparer.Ordinal))
            table = await connection.OpenTable("messages_v7");
        else
            table = await connection.CreateTable(
                "messages_v7",
                new CreateTableOptions
                {
                    Schema = Schema,
                    StorageOptions = new() { ["new_table_data_storage_version"] = "2.0" },
                }
            );
    }

    internal static RecordBatch Batch(IReadOnlyList<JsonObject> rows)
    {
        var arrays = new List<IArrowArray>();
        foreach (var name in Columns)
        {
            if (name == "vector")
            {
                var builder = new FixedSizeListArray.Builder(VectorItem, 1024);
                var values = (FloatArray.Builder)builder.ValueBuilder;
                foreach (var row in rows)
                {
                    var vector = row[name]!.AsArray();
                    if (vector.Count != 1024)
                        throw new InvalidDataException(
                            "Embedding does not fit the Vector table's 1024-dimensional schema."
                        );
                    builder.Append();
                    foreach (var value in vector)
                        values.Append((float)Sessions.SessionWait.Number(value)!.Value);
                }
                arrays.Add(builder.Build());
            }
            else if (Strings.Contains(name))
            {
                var builder = new StringArray.Builder();
                foreach (var row in rows)
                    if (row[name] is null)
                        builder.AppendNull();
                    else
                        builder.Append(VectorText.Text(row[name]));
                arrays.Add(builder.Build());
            }
            else
            {
                var builder = new DoubleArray.Builder();
                foreach (var row in rows)
                    if (row[name] is null)
                        builder.AppendNull();
                    else
                        builder.Append(Sessions.SessionWait.Number(row[name])!.Value);
                arrays.Add(builder.Build());
            }
        }
        return new(Schema, arrays, rows.Count);
    }

    internal async Task AddAsync(IReadOnlyList<JsonObject> rows, bool merge)
    {
        if (rows.Count == 0)
            return;
        using var batch = Batch(rows);
        if (merge)
            await table
                .MergeInsert("id")
                .WhenMatchedUpdateAll()
                .WhenNotMatchedInsertAll()
                .Execute(batch);
        else
            await table.Add(batch);
        MutationCompleted?.Invoke();
    }

    internal async Task DeleteAsync(string predicate)
    {
        await table.Delete(predicate);
        MutationCompleted?.Invoke();
    }

    internal async Task<IReadOnlyList<JsonObject>> SearchAsync(
        float[] vector,
        string? predicate,
        int limit
    )
    {
        var query = table.Query().NearestTo(vector).Limit(limit);
        if (predicate is not null)
            query = query.Where(predicate);
        var rows = await query
            .Select(Columns.Where(column => column != "vector").ToArray())
            .ToList();
        return rows.Select(row => JsonSerializer.SerializeToNode(row)!.AsObject()).ToArray();
    }

    internal async Task MaintenanceAsync(double retentionHours, bool periodic)
    {
        var stats = await table.Stats();
        var versions = await table.ListVersions();
        var cutoff = DateTimeOffset.UtcNow.AddHours(-retentionHours);
        var old = versions.Count(version =>
            DateTimeOffset.Parse(
                version.Timestamp,
                System.Globalization.CultureInfo.InvariantCulture
            ) < cutoff
        );
        if (stats.FragmentStats?.NumSmallFragments >= 256 || old >= 512 || periodic && old > 0)
        {
            await table.Optimize(TimeSpan.FromHours(retentionHours), deleteUnverified: false);
            _ = await table.Stats();
            _ = await table.ListVersions();
        }
    }

    public void Dispose()
    {
        table?.Dispose();
        connection.Dispose();
    }
}
