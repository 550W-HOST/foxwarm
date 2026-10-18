using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Vector;

// Private local owner transport, not a public API or a Session-worker facade.
internal static class VectorWire
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal static async Task<JsonObject?> ReadAsync(
        Stream stream,
        CancellationToken token = default
    )
    {
        var header = new byte[4];
        var read = await stream.ReadAsync(header.AsMemory(0, 1), token);
        if (read == 0)
            return null;
        await stream.ReadExactlyAsync(header.AsMemory(1), token);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0)
            throw new InvalidDataException("Invalid Vector owner frame length.");
        var body = new byte[length];
        await stream.ReadExactlyAsync(body, token);
        return JsonNode.Parse(body) as JsonObject
            ?? throw new InvalidDataException("Invalid Vector owner frame.");
    }

    internal static async Task WriteAsync(
        Stream stream,
        SemaphoreSlim lane,
        JsonObject message,
        CancellationToken token = default
    )
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, Json);
        var header = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
        await lane.WaitAsync(token);
        try
        {
            await stream.WriteAsync(header, token);
            await stream.WriteAsync(bytes, token);
            await stream.FlushAsync(token);
        }
        finally
        {
            lane.Release();
        }
    }

    internal static async Task<JsonNode?> DispatchAsync(
        VectorRuntime runtime,
        string method,
        JsonObject input
    )
    {
        var id = VectorText.Text(input["sessionId"]);
        switch (method)
        {
            case "search":
                return JsonSerializer.SerializeToNode(
                    await runtime.SearchAsync(
                        VectorText.Text(input["query"]),
                        (int)VectorRuntime.Number(input["limit"], 5),
                        input["options"]?.Deserialize<VectorSearchOptions>(Json)
                    ),
                    Json
                );
            case "schedule":
                runtime.Schedule(
                    id,
                    VectorRuntime.Integer(input["seq"]),
                    (int)VectorRuntime.Integer(input["tokens"]),
                    VectorRuntime.Integer(input["block"])
                );
                return runtime.Status(id);
            case "force":
                return JsonValue.Create(
                    await runtime.ForceAsync(
                        id,
                        VectorRuntime.Integer(input["seq"]),
                        VectorRuntime.Integer(input["block"])
                    )
                );
            case "facts":
                return JsonValue.Create(
                    await runtime.IndexFactsAsync(
                        input["record"]!.Deserialize<Sessions.ArchiveBlockRecord>(Json)!
                    )
                );
            case "status":
                return runtime.Status(id);
            case "startup":
                await runtime.WaitForStartupAsync();
                return null;
            case "rename":
                await runtime.RenameAsync(
                    VectorText.Text(input["oldId"]),
                    VectorText.Text(input["newId"])
                );
                return null;
            case "fork":
                await runtime.ForkAsync(id);
                return null;
            case "reset":
                await runtime.ResetAsync(id);
                return null;
            default:
                throw new InvalidDataException("Unknown Vector owner operation.");
        }
    }
}
