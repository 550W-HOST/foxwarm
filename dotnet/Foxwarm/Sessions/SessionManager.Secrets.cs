using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Secrets;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// Agent self-management of the secret store: add a value under a new name without it passing
// through the model again, and list names with their owners, uses and availability. Values
// are never returned.
internal sealed partial class SessionManager
{
    // A model-facing placeholder for add_secret's value wherever a call is shown to approvers.
    internal const string HiddenSecretValue = "(hidden)";

    // add_secret's secret fact: adding a value under a name configuration already references
    // lets those consumers use it. The name has no owner yet, so it needs a grant like any
    // other secret. A new, unreferenced name sends nothing anywhere.
    private IReadOnlyList<string>? AddSecretFacts(JsonObject args) =>
        SessionWait.Text(args["name"])?.Trim() is { } name ? UnsetReferencedSecrets([name]) : null;

    // ask_user's secret facts: the names its secret questions would fill that configuration
    // already references, as for add_secret.
    private IReadOnlyList<string>? AskUserSecretFacts(JsonObject args) =>
        args["questions"] is JsonArray questions
            ? UnsetReferencedSecrets(
                questions
                    .OfType<JsonObject>()
                    .Select(question => SessionWait.Text(question["secret"]?["name"])?.Trim())
                    .OfType<string>()
            )
            : null;

    // Of valid names without a current value, those configuration references.
    private IReadOnlyList<string>? UnsetReferencedSecrets(IEnumerable<string> names)
    {
        if (secrets is not { } owned || models.ConfigurationOwner is not { } configuration)
            return null;
        var candidates = names
            .Where(name => SecretStore.NamePattern().IsMatch(name))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (candidates.Length == 0)
            return [];
        try
        {
            candidates = candidates.Where(name => !owned.Store.Contains(name)).ToArray();
        }
        catch (SecretStoreLockedException)
        {
            return null;
        }
        var usages = configuration.SecretUsages(mcp.Configuration.Snapshot());
        return candidates.Where(usages.ContainsKey).Order(StringComparer.Ordinal).ToArray();
    }

    // A secret question may ask only for names that have no value yet.
    private void RequireNewSecretNames(IEnumerable<string> names)
    {
        var listed = names.ToArray();
        if (listed.Length == 0)
            return;
        if (secrets is not { } instance)
            throw new NotSupportedException("The secret store is unavailable on this host.");
        foreach (var name in listed)
            if (instance.Store.Contains(name))
                throw new InvalidOperationException(
                    $"Secret `{name}` already exists. Choose another name, or ask the user to replace it in Setup."
                );
    }

    // Stores the secrets entered in a WebUI answer, owned by the Session's Agent. Filling a
    // name configuration already uses changes what the instance sends, which only the
    // administrator may do.
    private IReadOnlyList<string> StoreSecretAnswers(
        SessionOwner owner,
        IReadOnlyList<SecretAnswer> entered,
        JsonObject? sender
    )
    {
        if (entered.Count == 0)
            return [];
        if (secrets is not { } instance || models.ConfigurationOwner is not { } configuration)
            throw new InvalidDataException("The secret store is unavailable on this host.");
        var administrator = sender is null || SessionWait.Text(sender["kind"]) == "administrator";
        var usages = configuration.SecretUsages(mcp.Configuration.Snapshot());
        foreach (var answer in entered)
            if (!administrator && usages.ContainsKey(answer.Name))
                throw new InvalidDataException(
                    $"Only the administrator can enter `{answer.Name}`, because configuration already uses it."
                );
        var stored = new List<string>();
        try
        {
            foreach (var answer in entered)
            {
                instance.Store.Create(answer.Name, answer.Value, answer.Description, owner.Agent);
                stored.Add(answer.Name);
            }
        }
        catch (Exception error) when (error is InvalidOperationException or InvalidDataException)
        {
            RemoveSecretAnswers(stored);
            throw new InvalidDataException(error.Message);
        }
        return stored;
    }

    // Undoes StoreSecretAnswers for an answer that was not admitted. The values never reached
    // the model, so nothing needs to stay masked.
    private void RemoveSecretAnswers(IReadOnlyList<string> names)
    {
        if (secrets is not { } instance)
            return;
        foreach (var name in names)
            try
            {
                instance.Store.Withdraw(name);
            }
            catch (Exception error) when (error is InvalidOperationException or IOException)
            {
                MainLog.Diagnostic(
                    $"Secret {name} from an unadmitted answer could not be removed: "
                        + MainLog.SafeFailure(error),
                    failure: true
                );
            }
    }

    private async Task RestartSecretConsumersAsync(IReadOnlyList<string> names)
    {
        if (models.ConfigurationOwner?.ManagedChannels is not { } channels)
            return;
        foreach (var name in names)
            await channels.RestartReferencingAsync(name);
    }

    internal async Task<JsonObject> AddSecretAsync(
        SessionOwner owner,
        WorkspaceTools files,
        string node,
        string? cwd,
        JsonObject args,
        Func<string, CancellationToken, Task> deleteFile,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(
            args,
            ["name", "description", "value", "filePath", "deleteFile", "fromConfig"]
        );
        if (secrets is not { } instance || models.ConfigurationOwner is not { } configuration)
            throw new NotSupportedException("The secret store is unavailable on this host.");
        var store = instance.Store;
        var name = SessionWait.Text(args["name"])?.Trim() ?? "";
        SecretStore.ValidateName(name);
        var description = args["description"] is null
            ? null
            : ToolRegistry.Text(args, "description");
        var sources = new[] { "value", "filePath", "fromConfig" }
            .Where(key => args[key] is not null)
            .ToArray();
        if (sources.Length != 1)
            throw new InvalidDataException("Give exactly one of value, filePath or fromConfig.");
        var removeFile = args["deleteFile"] switch
        {
            null => false,
            JsonValue flag when flag.TryGetValue<bool>(out var delete) => delete,
            _ => throw new InvalidDataException("deleteFile must be true or false."),
        };
        if (removeFile && sources[0] != "filePath")
            throw new InvalidDataException("deleteFile applies only with filePath.");
        if (store.Contains(name))
            throw new InvalidOperationException(
                $"Secret `{name}` already exists. Choose another name, or ask the user to replace it in Setup."
            );
        var result = new JsonObject { ["name"] = name };
        if (sources[0] == "fromConfig")
            return await MoveSecretLiteralAsync(
                owner,
                files,
                configuration,
                store,
                name,
                description,
                args,
                result,
                token
            );
        string value;
        if (sources[0] == "value")
            value =
                args["value"] is JsonValue text && text.TryGetValue<string>(out var given)
                    ? given
                    : throw new InvalidDataException("value must be text.");
        else
        {
            var path = ToolRegistry.Text(args, "filePath") ?? "";
            if (path.Length == 0 || path.IndexOfAny(['\r', '\n', '\0']) >= 0)
                throw new InvalidDataException("filePath must be one nonempty path.");
            await AuthorizeNodeFileAsync(owner, node, path, "read", files, token);
            value = await ReadSecretFileAsync(owner, files, node, cwd, path, token);
            if (removeFile)
                await AuthorizeToolAsync(
                    owner,
                    new("edit", "node", "edit", DeletePatch(path), ExecutionNode: node),
                    files,
                    token
                );
        }
        // The facts of the call as it now takes effect.
        await AuthorizeToolAsync(
            owner,
            new("add_secret", "builtin", "add_secret", args),
            files,
            token,
            secrets: AddSecretFacts(args) ?? []
        );
        var metadata = store.Create(name, value, description, owner.Agent);
        // A value given in the call stays in that call's record; later copies are masked.
        if (sources[0] == "value")
            instance.Exposures.Record([name], "tool-call", owner.Id);
        Describe(result, metadata);
        if (removeFile)
        {
            try
            {
                await deleteFile(ToolRegistry.Text(args, "filePath")!, token);
                result["fileDeleted"] = true;
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                result["fileDeleted"] = false;
                result["warning"] = AppendWarning(
                    result,
                    "The secret was stored, but the file could not be deleted: " + error.Message
                );
            }
        }
        if (configuration.ManagedChannels is { } channels)
        {
            var restarted = await channels.RestartReferencingAsync(name);
            if (restarted.Count > 0)
                result["restartedChannels"] = new JsonArray(
                    restarted.Select(id => (JsonNode?)id).ToArray()
                );
        }
        return result;
    }

    internal static JsonObject DeletePatch(string path) =>
        new() { ["apply_patch"] = $"*** Begin Patch\n*** Delete File: {path}\n*** End Patch" };

    private async Task<string> ReadSecretFileAsync(
        SessionOwner owner,
        WorkspaceTools files,
        string node,
        string? cwd,
        string path,
        CancellationToken token
    )
    {
        const int limit = SecretStore.MaximumValueBytes + 5;
        static void Bound(long size)
        {
            if (size > limit)
                throw new InvalidDataException(
                    "The file is larger than 64 KiB, the limit for a secret value."
                );
        }
        byte[] bytes;
        if (node == "master")
            bytes = (await ReadNodeFileAsync(owner, node, path, files, token, Bound)).Bytes;
        else if (NodeProviders.IsProviderNode(node))
            bytes = await NodeProviders.ReadSourceAsync(node, path, cwd, token, Bound);
        else
            bytes = (
                await ReadResidentSourceAsync(owner, node, path, cwd, files, token, Bound)
            ).Bytes;
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF');
        }
        catch (DecoderFallbackException)
        {
            throw new InvalidDataException("The file is not UTF-8 text.");
        }
        // Files written by `echo` or an editor end with one line break that is not part of
        // the value.
        if (text.EndsWith("\r\n", StringComparison.Ordinal))
            text = text[..^2];
        else if (text.EndsWith('\n'))
            text = text[..^1];
        if (text.Length == 0)
            throw new InvalidDataException("The file is empty.");
        return text;
    }

    // Moves a literal from configuration fields into the store under a new instance-owned
    // name, replacing each field with a reference. The store is written first; a field that
    // changed in the meantime is reported and left as it was.
    private async Task<JsonObject> MoveSecretLiteralAsync(
        SessionOwner owner,
        WorkspaceTools files,
        Foxwarm.Models.ModelConfiguration configuration,
        SecretStore store,
        string name,
        string? description,
        JsonObject args,
        JsonObject result,
        CancellationToken token
    )
    {
        var locations = SecretLiteralMove.Parse(args["fromConfig"]);
        var reference = SecretLiteralMove.Reference(name);
        // The moved value is one the caller does not see, filed under a name it chooses, and
        // secrets rules grant by name. So a move needs what reading the value directly would:
        // permission to read the file it comes from.
        var master = IdentityWorkspace(owner, null, "master");
        foreach (var target in locations.Select(location => location.Target).Distinct())
            await AuthorizeToolAsync(
                owner,
                new(
                    "add_secret",
                    "node",
                    "read",
                    new JsonObject
                    {
                        ["filePath"] = target switch
                        {
                            "models" => configuration.ActivePath,
                            "config" => configuration.AppPath,
                            _ => mcp.Configuration.FilePath,
                        },
                    }
                ),
                master,
                token
            );
        var literals = new List<string>();
        var documents = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var group in locations.GroupBy(location => location.Target))
        {
            var listed = group.ToArray();
            if (group.Key == "mcp")
            {
                literals.Add(
                    SecretLiteralMove.Mcp(mcp.Configuration.Snapshot(), listed, reference).Literal
                );
                continue;
            }
            var (text, _) = configuration.ReadInstalledRaw(group.Key);
            var label = Label(group.Key);
            var literal = SecretLiteralMove.ReadYaml(text, listed, Sinks(group.Key), label);
            _ = SecretLiteralMove.RewriteYaml(text, listed, literal, reference, label);
            literals.Add(literal);
            documents[group.Key] = text;
        }
        if (literals.Distinct(StringComparer.Ordinal).Count() != 1)
            throw new InvalidDataException("The listed fields hold different values.");
        var value = literals[0];
        await AuthorizeToolAsync(
            owner,
            new("add_secret", "builtin", "add_secret", args),
            files,
            token,
            secrets: AddSecretFacts(args) ?? []
        );
        Describe(result, store.Create(name, value, description, ownerAgent: null));
        var moved = new JsonArray();
        var notMoved = new JsonArray();
        foreach (var group in locations.GroupBy(location => location.Target))
        {
            var listed = group.ToArray();
            try
            {
                if (group.Key == "mcp")
                {
                    var snapshot = mcp.Configuration.Snapshot();
                    var (literal, patches) = SecretLiteralMove.Mcp(snapshot, listed, reference);
                    if (literal != value)
                        throw new InvalidDataException("The field changed in the meantime.");
                    foreach (var (server, patch) in patches)
                        await mcp.ReplaceLiteralAsync(server, patch, snapshot[server]!.AsObject());
                }
                else
                {
                    var label = Label(group.Key);
                    await configuration.InstallAsync(
                        group.Key,
                        _ =>
                        {
                            var (text, bom) = configuration.ReadInstalledRaw(group.Key);
                            if (
                                SecretLiteralMove.ReadYaml(text, listed, Sinks(group.Key), label)
                                != value
                            )
                                throw new InvalidOperationException(
                                    "The field changed in the meantime."
                                );
                            var rewritten = SecretLiteralMove.RewriteYaml(
                                text,
                                listed,
                                value,
                                reference,
                                label
                            );
                            var bytes = Encoding.UTF8.GetBytes(rewritten);
                            return Task.FromResult(bom ? [0xEF, 0xBB, 0xBF, .. bytes] : bytes);
                        },
                        token: token,
                        webhooksLocked: true
                    );
                }
                foreach (var location in listed)
                    moved.Add(location.Display);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                foreach (var location in listed)
                    notMoved.Add(
                        new JsonObject
                        {
                            ["location"] = location.Display,
                            ["error"] = error.Message,
                        }
                    );
            }
        }
        result["moved"] = moved;
        if (notMoved.Count > 0)
        {
            result["notMoved"] = notMoved;
            result["warning"] = AppendWarning(
                result,
                "The secret was stored, but some fields still hold the value."
            );
        }
        return result;

        static string Label(string target) => target == "models" ? "models config" : "app config";
        static SecretSinks Sinks(string target) =>
            target == "models" ? SecretSinks.Models : SecretSinks.App;
    }

    private static void Describe(JsonObject result, SecretMetadata metadata)
    {
        result["stored"] = true;
        result["owner"] = Foxwarm.Channels.WebUi.WebUIChannel.SecretOwnerJson(metadata.Owner);
        if (!metadata.Redactable)
            result["warning"] =
                $"Values shorter than {SecretStore.MinimumRedactableLength} characters cannot be hidden from tool output and model requests.";
    }

    private static string AppendWarning(JsonObject result, string warning) =>
        SessionWait.Text(result["warning"]) is { } existing ? existing + " " + warning : warning;

    internal async Task<JsonObject> ListSecretsAsync(
        SessionOwner owner,
        WorkspaceTools files,
        string node,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, []);
        if (secrets is not { } instance || models.ConfigurationOwner is not { } configuration)
            throw new NotSupportedException("The secret store is unavailable on this host.");
        var listed = instance.Store.List().ToDictionary(item => item.Name, StringComparer.Ordinal);
        var usages = configuration.SecretUsages(mcp.Configuration.Snapshot());
        var output = new JsonArray();
        foreach (
            var name in listed
                .Keys.Concat(usages.Keys)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
        )
        {
            listed.TryGetValue(name, out var metadata);
            var item = new JsonObject
            {
                ["name"] = name,
                ["description"] = metadata?.Description ?? "",
                ["set"] = metadata?.IsSet == true,
                ["owner"] = Foxwarm.Channels.WebUi.WebUIChannel.SecretOwnerJson(metadata?.Owner),
                ["usages"] = new JsonArray(
                    (usages.TryGetValue(name, out var used) ? used : [])
                        .Select(usage => (JsonNode?)usage.DeepClone())
                        .ToArray()
                ),
            };
            if (metadata?.IsSet == true)
                item["usable"] = await SecretUsableAsync(owner, files, node, name, token);
            output.Add(item);
        }
        return new JsonObject { ["secrets"] = output };
    }

    // The caller's policy decision for using a secret at its current Node, as the secret part
    // of an exec there. Whether a particular command may run is decided separately.
    private async Task<string> SecretUsableAsync(
        SessionOwner owner,
        WorkspaceTools files,
        string node,
        string name,
        CancellationToken token
    )
    {
        AuthorizationAssessment assessment;
        try
        {
            assessment = await AssessToolAsync(
                owner,
                new("exec", "node", "exec", new JsonObject(), ExecutionNode: node),
                files,
                token,
                secrets: [name]
            );
        }
        catch (ToolAuthorizationDeniedException)
        {
            return "deny";
        }
        var effect = assessment
            .Layers.Select(layer => layer.Decision.Secrets?.Effect ?? ToolAuthorizationEffect.Allow)
            .DefaultIfEmpty(ToolAuthorizationEffect.Allow)
            .Max();
        if (
            Isolation(owner.Agent).Isolated
            && assessment.Request.OwnedSecrets?.Contains(name) != true
        )
            effect = ToolAuthorizationEffect.Deny;
        return AuthorizationDecision.Name(effect);
    }
}
