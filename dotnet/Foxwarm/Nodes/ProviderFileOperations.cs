using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Nodes;

internal sealed class ProviderFileOperations(ExecutableNodeProvider provider, string node, string? cwd) : ITargetFileOperations
{
    private Task<JsonNode?> CallAsync(string operation, string path, CancellationToken token, Action<JsonObject>? fields = null)
    {
        TargetFileContent.RequirePath(path);
        var request = new JsonObject
        {
            ["nodeId"] = node,
            ["operation"] = operation,
            ["path"] = path,
            ["context"] = cwd is null ? new JsonObject() : new JsonObject { ["cwd"] = cwd },
        };
        fields?.Invoke(request);
        return provider.RunAsync("filesystem", request, token);
    }

    private static NodeProviderException Invalid() => new("NODE_PROVIDER_FILESYSTEM_INVALID_RESULT", "Provider filesystem returned an invalid result.");

    private static TargetFileStat Stat(JsonNode? raw, bool entry = false)
    {
        if (raw is not JsonObject value
            || SessionWait.Text(value["kind"]) is not ("file" or "directory" or "symlink" or "other")
            || SessionWait.Number(value["size"]) is not double size || size < 0 || size > 9007199254740991 || Math.Truncate(size) != size
            || SessionWait.Number(value["modifiedAtMs"]) is not double modified || !double.IsFinite(modified)
            || entry && SessionWait.Text(value["name"]) is null)
            throw Invalid();
        return new(value["kind"]!.GetValue<string>(), (long)size, modified, SessionWait.Text(value["name"]));
    }

    public async Task<TargetFileStat> StatAsync(string path, CancellationToken token) => Stat(await CallAsync("stat", path, token));

    public async Task<byte[]> ReadAsync(string path, long offset, int count, CancellationToken token)
    {
        var value = await CallAsync("read", path, token, request => { request["offset"] = offset; request["count"] = count; });
        if (value is not JsonObject result || SessionWait.Text(result["dataBase64"]) is not string encoded) throw Invalid();
        byte[] bytes;
        try { bytes = Convert.FromBase64String(encoded); }
        catch (FormatException) { throw Invalid(); }
        if (bytes.Length > count || Convert.ToBase64String(bytes) != encoded) throw Invalid();
        return bytes;
    }

    public async Task<IReadOnlyList<TargetFileStat>> ReadDirectoryAsync(string path, CancellationToken token)
    {
        if (await CallAsync("readdir", path, token) is not JsonArray values) throw Invalid();
        return values.Select(value => Stat(value, true)).ToArray();
    }

    public async Task<string> ParentAsync(string path, CancellationToken token)
    {
        if (await CallAsync("parent", path, token) is not JsonObject result || SessionWait.Text(result["path"]) is not { Length: > 0 } parent) throw Invalid();
        return parent;
    }

    public async Task WriteAsync(string path, byte[] bytes, string flag, CancellationToken token) =>
        _ = await CallAsync("write", path, token, request => { request["contentBase64"] = Convert.ToBase64String(bytes); request["flag"] = flag; });
    public async Task MakeDirectoryAsync(string path, CancellationToken token) => _ = await CallAsync("mkdir", path, token);
    public async Task RemoveAsync(string path, CancellationToken token) => _ = await CallAsync("remove", path, token);
}
