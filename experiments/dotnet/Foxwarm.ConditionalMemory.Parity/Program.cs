using System.Text.Json;
using Foxwarm.ConditionalMemory;
using Foxwarm.MessageJson;
using System.Text.Json.Nodes;

var corpusPath = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "parity-corpus.json");
var corpus = JsonSerializer.Deserialize<List<ParityCase>>(await File.ReadAllTextAsync(corpusPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
var results = corpus.Select(item => item.Op switch
{
    "filter" => new Result("value", ConditionalMemory.FilterConditionalMemorySource(item.Source ?? "", item.ModelId ?? "")),
    "build" => new Result("value", ConditionalMemory.BuildCurrentModelSnapshot(item.ModelId ?? "", item.Body ?? "")),
    "message" => new Result("value", CanonicalMessage.Parse(item.Message ?? "").ToJson()),
    "visible" => new Result("value", CanonicalMessage.Parse(item.Message ?? "").IsModelVisible),
    "argsStringify" => new Result("value", FunctionCallArguments.Stringify(item.Args, item.RawArgsText, item.ArgsParseError)),
    "argsParse" => new Result("value", JsonNode.Parse(JsonSerializer.Serialize(FunctionCallArguments.Parse(item.RawInput.ValueKind is JsonValueKind.Undefined ? null : JsonNode.Parse(item.RawInput.GetRawText())), new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull }))),
    "read" => ConditionalMemory.ReadCurrentModelSnapshotId(item.Snapshot ?? "") is { } value ? new Result("value", value) : new Result("undefined", null),
    _ => throw new InvalidOperationException($"Unknown operation {item.Op}")
});
Console.Write(JsonSerializer.Serialize(results, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));

record ParityCase(string Name, string Op, string? Source, string? ModelId, string? Body, string? Snapshot, string? Message, string? RawArgsText, JsonObject? Args, string? ArgsParseError, System.Text.Json.JsonElement RawInput);
record Result(string Kind, [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] object? Value);
