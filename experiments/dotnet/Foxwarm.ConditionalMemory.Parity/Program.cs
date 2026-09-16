using System.Text.Json;
using Foxwarm.ConditionalMemory;

var corpusPath = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "parity-corpus.json");
var corpus = JsonSerializer.Deserialize<List<ParityCase>>(await File.ReadAllTextAsync(corpusPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
var results = corpus.Select(item => item.Op switch
{
    "filter" => new Result("value", ConditionalMemory.FilterConditionalMemorySource(item.Source ?? "", item.ModelId ?? "")),
    "build" => new Result("value", ConditionalMemory.BuildCurrentModelSnapshot(item.ModelId ?? "", item.Body ?? "")),
    "read" => ConditionalMemory.ReadCurrentModelSnapshotId(item.Snapshot ?? "") is { } value ? new Result("value", value) : new Result("undefined", null),
    _ => throw new InvalidOperationException($"Unknown operation {item.Op}")
});
Console.Write(JsonSerializer.Serialize(results, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));

record ParityCase(string Name, string Op, string? Source, string? ModelId, string? Body, string? Snapshot);
record Result(string Kind, [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? Value);
