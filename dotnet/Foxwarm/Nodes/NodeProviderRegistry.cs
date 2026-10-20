using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Nodes;

/// <summary>Main-owned generic capability boundary. Native credentials/services stay in the resident hub.</summary>
internal sealed partial class NodeProviderRegistry
{
    private readonly NodeConnectionHub native;
    private readonly Dictionary<string, ExecutableNodeProvider> providers = new(
        StringComparer.Ordinal
    );
    private readonly ConcurrentDictionary<string, JsonObject> discovered = new(
        StringComparer.Ordinal
    );
    private readonly PendingWriteRefs pending;

    internal NodeProviderRegistry(
        NodeConnectionHub native,
        JsonObject? configuration = null,
        PendingWriteRefs? pending = null
    )
    {
        this.native = native;
        this.pending = pending ?? new();
        var app = new JsonObject();
        if (configuration is not null)
            app["nodeProviders"] = configuration.DeepClone();
        AppConfigurationRules.Validate(app);
        foreach (var (id, raw) in configuration ?? new JsonObject())
        {
            if (id is "master" or "authenticated-remote")
                throw new InvalidDataException("Node provider identity is reserved.");
            providers.Add(id, new(id, (JsonObject)raw!.DeepClone()));
        }
    }

    internal static void ValidateId(string id)
    {
        if (id == "master")
            return;
        if (
            !Regex.IsMatch(
                id,
                "^(?:[A-Za-z0-9._:-]{1,128}|[A-Za-z0-9][A-Za-z0-9._:-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$",
                RegexOptions.CultureInvariant
            )
        )
            throw new InvalidDataException("Invalid Node identity.");
    }

    internal bool IsProviderNode(string id) => id.Contains('/');

    internal bool Online(string id) =>
        IsProviderNode(id)
            ? discovered.TryGetValue(id, out var descriptor)
                && SessionWait.Text(descriptor["availability"]) == "ready"
            : native.Online(id);

    internal bool Connected(string id) => IsProviderNode(id) ? Online(id) : native.Connected(id);

    internal string? DefaultCwd(string id) =>
        IsProviderNode(id)
            ? discovered.TryGetValue(id, out var descriptor)
                ? SessionWait.Text(descriptor["defaultCwd"])
                : null
            : native.ShellDefaultCwd(id);

    // Synchronous readers consume a projection only; subprocess discovery never runs under their locks.
    // Actual effects always perform fresh asynchronous exact-owner/capability resolution.
    internal JsonArray Snapshot() =>
        new(
            discovered
                .Values.OrderBy(value => SessionWait.Text(value["id"]), StringComparer.Ordinal)
                .Select(Summary)
                .Cast<JsonNode?>()
                .ToArray()
        );

    internal async Task<JsonArray> ListAsync(CancellationToken token)
    {
        var values = new List<JsonObject>();
        foreach (var provider in providers.Values)
            values.AddRange((await provider.ListAsync(token)).OfType<JsonObject>());
        var fixedIds = native
            .List()
            .OfType<JsonObject>()
            .Select(value => SessionWait.Text(value["id"]))
            .Append("master")
            .ToHashSet(StringComparer.Ordinal);
        var ids = new HashSet<string>(fixedIds!, StringComparer.Ordinal);
        foreach (var value in values)
            if (!ids.Add(value["id"]!.GetValue<string>()))
                throw new NodeProviderException(
                    "NODE_PROVIDER_DUPLICATE_NODE",
                    "Multiple providers own the same Node identity."
                );
        discovered.Clear();
        foreach (var value in values)
            discovered[value["id"]!.GetValue<string>()] = (JsonObject)value.DeepClone();
        return new JsonArray(values.Select(Summary).Cast<JsonNode?>().ToArray());
    }

    internal async Task<JsonObject?> ResolveAsync(string id, CancellationToken token)
    {
        ValidateId(id);
        // Fixed native owners never consult optional executable discovery.
        if (!IsProviderNode(id))
            return id == "master"
                ? new JsonObject { ["id"] = id, ["availability"] = "ready" }
                : native
                    .List()
                    .OfType<JsonObject>()
                    .FirstOrDefault(value => SessionWait.Text(value["id"]) == id);
        var slash = id.IndexOf('/');
        if (!providers.TryGetValue(id[..slash], out var provider))
            return null;
        JsonArray nodes;
        try
        {
            nodes = await provider.ListAsync(token);
        }
        catch
        {
            discovered.TryRemove(id, out _);
            throw;
        }
        var descriptor = nodes
            .OfType<JsonObject>()
            .FirstOrDefault(value => SessionWait.Text(value["id"]) == id);
        if (descriptor is not null)
            discovered[id] = (JsonObject)descriptor.DeepClone();
        else
            discovered.TryRemove(id, out _);
        return descriptor;
    }

    internal async Task RefreshAsync(string id, CancellationToken token)
    {
        if (IsProviderNode(id))
            _ = await ResolveAsync(id, token);
    }

    internal JsonArray Definitions(string id)
    {
        if (!IsProviderNode(id))
            return native.DiscoveredDefinitions(id);
        if (!Online(id) || !discovered.TryGetValue(id, out var descriptor))
            return [];
        return DefinitionsFor(descriptor);
    }

    private static JsonArray ProviderDefinitions()
    {
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in definitions.OfType<JsonObject>())
        {
            var name = SessionWait.Text(definition["name"]);
            if (name is "read" or "write" or "edit")
                definition["parameters"]!["properties"]!["filePath"]!["description"] =
                    (
                        name == "read" ? "File or directory path"
                        : name == "write" ? "Destination path"
                        : "File to edit"
                    )
                    + " on this Node. Relative paths use the Session's working directory, or the Node's default directory when unset. Path syntax and home-directory handling are defined by the Node. $fw_agentdir and $fw_tmp are not supported.";
            else if (name == "apply_patch")
                definition["description"] = definition["description"]!
                    .GetValue<string>()
                    .Replace(
                        "Paths in patch headers use the session working directory, or the agent directory when unset. Absolute paths, ~/ paths, and leading $fw_agentdir or $fw_tmp are accepted subject to permissions. Other leading $ names are rejected.",
                        "Relative paths in patch headers use the Session's working directory, or the Node's default directory when unset. Path syntax and home-directory handling are defined by the Node. $fw_agentdir and $fw_tmp are not supported.",
                        StringComparison.Ordinal
                    );
        }
        return definitions;
    }

    private JsonObject Summary(JsonObject descriptor)
    {
        var id = descriptor["id"]!.GetValue<string>();
        var ready = SessionWait.Text(descriptor["availability"]) == "ready";
        return new JsonObject
        {
            ["id"] = id,
            ["nodeId"] = id,
            ["provider"] = descriptor["provider"]!.DeepClone(),
            ["type"] = descriptor["type"]!.DeepClone(),
            ["kind"] = descriptor["kind"]!.DeepClone(),
            ["displayName"] = descriptor["label"]?.DeepClone() ?? JsonValue.Create(id),
            ["availability"] = descriptor["availability"]!.DeepClone(),
            ["online"] = ready,
            ["connected"] = ready,
            ["executable"] = ready,
            ["services"] = new JsonObject(),
            ["tools"] = DefinitionsFor(descriptor),
        };
    }

    private static JsonArray DefinitionsFor(JsonObject descriptor)
    {
        if (SessionWait.Text(descriptor["availability"]) != "ready")
            return [];
        var definitions = ProviderDefinitions();
        if (SessionWait.Text(descriptor["filesystem"]) == "read")
            definitions = new JsonArray(
                definitions
                    .Where(value => SessionWait.Text(value?["name"]) == "read")
                    .Select(value => value!.DeepClone())
                    .ToArray()
            );
        if (descriptor["exec"]?.GetValue<bool>() == true)
            definitions.Add(LocalExecManager.Definitions()[0]!.DeepClone());
        return definitions;
    }

    internal async Task<ProviderExecBackend> AdmitExecAsync(string node, CancellationToken token)
    {
        var descriptor = await ResolveAsync(node, token);
        if (
            descriptor is null
            || SessionWait.Text(descriptor["availability"]) != "ready"
            || descriptor["exec"]?.GetValue<bool>() != true
        )
            throw new InvalidOperationException("Node exec capability is unavailable: " + node);
        return ResolveExecBackend(node[..node.IndexOf('/')], node);
    }

    // An admitted persistent reference belongs to the exact configured backend, not live discovery.
    internal ProviderExecBackend ResolveExecBackend(string providerId, string node)
    {
        ValidateId(node);
        if (
            !node.StartsWith(providerId + "/", StringComparison.Ordinal)
            || !providers.TryGetValue(providerId, out var provider)
        )
            throw new InvalidOperationException(
                "Execution provider is not configured: " + providerId
            );
        return new(provider, node);
    }

    private async Task<ITargetFileOperations> FileOperationsAsync(
        string node,
        bool write,
        string? cwd,
        CancellationToken token
    )
    {
        var descriptor =
            await ResolveAsync(node, token)
            ?? throw new InvalidOperationException("Node is unavailable: " + node);
        if (
            SessionWait.Text(descriptor["availability"]) != "ready"
            || write && SessionWait.Text(descriptor["filesystem"]) != "read-write"
        )
            throw new InvalidOperationException("Node file capability is unavailable: " + node);
        var slash = node.IndexOf('/');
        return new ProviderFileOperations(providers[node[..slash]], node[(slash + 1)..], cwd);
    }

    internal async Task<JsonNode?> ExecuteAsync(
        string node,
        string name,
        JsonObject args,
        string sessionId,
        string agent,
        string currentNode,
        string? cwd,
        bool programmatic,
        CancellationToken token,
        SessionOwner? owner = null,
        Action<JsonNode?>? pathMetadata = null,
        Foxwarm.ToolScript.ToolScriptDataBudget? budget = null
    )
    {
        if (!IsProviderNode(node))
            return await native.ExecuteAsync(
                node,
                name,
                args,
                sessionId,
                agent,
                currentNode,
                cwd,
                programmatic,
                token,
                owner,
                pathMetadata
            );
        if (owner is null)
            throw new InvalidOperationException("Primitive file tools require a Session owner.");
        if (name is not ("read" or "write" or "edit" or "apply_patch"))
            throw new InvalidOperationException("Tool is unavailable on this Node: " + name);
        var operations = await FileOperationsAsync(
            node,
            name != "read",
            currentNode == node ? cwd : null,
            token
        );
        var workspace = new WorkspaceTools(operations, pending, sessionId, agent, owner)
        {
            Programmatic = programmatic,
            ScriptBudget = budget,
        };
        return await workspace.ExecuteAsync(
            new JsonObject { ["name"] = name, ["args"] = args.DeepClone() },
            token
        );
    }

    internal async Task<NodeConnectionHub.TransferFile> ReadFileAsync(
        string node,
        string path,
        SessionOwner owner,
        bool ingress,
        CancellationToken token,
        Action<long>? beforeMaterialize = null
    )
    {
        if (!IsProviderNode(node))
            return await native.ReadFileAsync(node, path, owner, ingress, token, beforeMaterialize);
        var operations = await FileOperationsAsync(node, false, null, token);
        var bytes = await TargetFileContent.ReadAsync(
            operations,
            path,
            NodeConnectionHub.FileLimit,
            token,
            beforeMaterialize,
            requireRegular: true
        );
        var name = NodeConnectionHub.RemoteFileName(path);
        return new(bytes, path, name, PrimitiveTransferMime(name));
    }

    private static string PrimitiveTransferMime(string name) =>
        Path.GetExtension(name).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            ".svg" => "image/svg+xml",
            ".json" => "application/json",
            ".txt" or ".ts" or ".js" or ".sh" => "text/plain",
            ".md" => "text/markdown",
            ".yaml" or ".yml" => "application/yaml",
            _ => "application/octet-stream",
        };

    internal async Task<byte[]> ReadSourceAsync(
        string node,
        string path,
        string? cwd,
        CancellationToken token,
        Action<long>? beforeMaterialize = null,
        int limit = int.MaxValue,
        bool boundRequests = false
    )
    {
        var operations = await FileOperationsAsync(node, false, cwd, token);
        return await TargetFileContent.ReadAsync(
            operations,
            path,
            limit,
            token,
            beforeMaterialize,
            chunkSize: 65536,
            boundRequests: boundRequests
        );
    }

    internal async Task<JsonObject> WriteFileAsync(
        string node,
        string path,
        byte[] bytes,
        bool overwrite,
        SessionOwner owner,
        bool ingress,
        CancellationToken token
    )
    {
        if (!IsProviderNode(node))
            return await native.WriteFileAsync(node, path, bytes, overwrite, owner, ingress, token);
        if (bytes.Length > NodeConnectionHub.FileLimit)
            throw new IOException("File exceeds the 50 MiB transfer limit.");
        owner.Entry.RequireIdentityAuthority();
        var operations = await FileOperationsAsync(node, true, null, token);
        await TargetFileContent.WriteAsync(operations, path, bytes, overwrite, token);
        return new JsonObject { ["filePath"] = path, ["sizeBytes"] = bytes.Length };
    }
}
