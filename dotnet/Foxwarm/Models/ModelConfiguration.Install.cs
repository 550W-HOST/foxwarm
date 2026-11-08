using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Models;

internal sealed partial class ModelConfiguration
{
    internal Task<JsonObject> SaveAsync(JsonObject input) =>
        InstallAsync(
            "models",
            _ =>
                Task.FromResult(
                    Encoding.UTF8.GetBytes(
                        input.ContainsKey("yaml") ? JsString(input["yaml"]) : BuildForm(input)
                    )
                )
        );

    internal Task<JsonObject> SaveAppAsync(string raw) =>
        InstallAsync("config", _ => Task.FromResult(Encoding.UTF8.GetBytes(raw)));

    private byte[] BuildChannelsBytes(JsonObject channels)
    {
        var currentRaw = ReadCurrentAppRaw();
        var current = ConfigurationYaml.Parse(currentRaw, "app config");
        AppConfigurationRules.Validate(current);
        // JSON is valid YAML; retain a complete JSON root rather than appending YAML to it.
        try
        {
            if (JsonNode.Parse(currentRaw) is JsonObject json)
            {
                json["channels"] = channels.DeepClone();
                return Encoding.UTF8.GetBytes(
                    json.ToJsonString(
                        new System.Text.Json.JsonSerializerOptions { WriteIndented = true }
                    )
                );
            }
        }
        catch (System.Text.Json.JsonException) { }
        var serialized = ChannelsYamlForObject(channels).TrimEnd();
        var section =
            serialized.Length == 0 || serialized == "{}"
                ? "channels: {}"
                : "channels:\n"
                    + string.Join(
                        "\n",
                        serialized.Split('\n').Select(line => line.Length == 0 ? line : "  " + line)
                    );
        return Encoding.UTF8.GetBytes(ReplaceTopLevelSection(currentRaw, "channels", section));
    }

    // Every candidate factory and section read runs after prior installations settle.
    internal async Task<JsonObject> InstallAsync(
        string target,
        Func<CancellationToken, Task<byte[]>> candidate,
        ToolAuthorizationAuthority? authorization = null,
        Func<CancellationToken, Task>? authorize = null,
        CancellationToken token = default,
        bool webhooksLocked = false
    )
    {
        await mutation.WaitAsync(token);
        try
        {
            if (authorize is not null)
                await authorize(token);
            token.ThrowIfCancellationRequested();
            if (target == "config")
                return await InstallAppAsync(candidate, token, webhooksLocked);
            var bytes = await candidate(token);
            if (target == "tool-rules")
            {
                if (authorization is null)
                    throw new InvalidOperationException(
                        "Tool authorization installation is unavailable."
                    );
                await authorization.InstallAsync(bytes, token);
                return Installed(target, ["tool-rules"], [], []);
            }
            var raw = new UTF8Encoding(false, true).GetString(bytes);
            // UTF-8 BOM is preserved in the installed bytes, but is not part of YAML.
            if (raw.StartsWith('\uFEFF'))
                raw = raw[1..];
            if (target == "models")
            {
                var firstRun = !File.Exists(ActivePath);
                var generation = Secrets.Store.Generation;
                bool whileLocked;
                HostModels next;
                lock (gate)
                {
                    resolvedWhileLocked = false;
                    next = Validate(raw);
                    whileLocked = resolvedWhileLocked;
                }
                // First-run Setup ends with this save, so it must not install an unfinished key.
                if (!File.Exists(ActivePath))
                    ModelApiKeys.EnsureUsableForFirstRun(next);
                await ReplaceRawAsync(
                    ActivePath,
                    bytes,
                    token,
                    () =>
                    {
                        lock (gate)
                        {
                            catalog = next;
                            cachedRaw = raw;
                            cachedSecretGeneration = generation;
                            cachedWhileLocked = whileLocked;
                        }
                        Secrets.Invalidate();
                    }
                );
                // The seed is a separate first-run effect; the models receipt keeps its shape.
                if (firstRun)
                    await SeedAppAsync(token);
                return Installed(target, ["models"], [], []);
            }
            throw new InvalidDataException("Unknown configuration target.");
        }
        finally
        {
            mutation.Release();
        }
    }

    private async Task<JsonObject> InstallAppAsync(
        Func<CancellationToken, Task<byte[]>> candidate,
        CancellationToken token,
        bool webhooksLocked = false
    )
    {
        var (config, access) = await PersistAppAsync(candidate, token, webhooksLocked);
        var restart = app.Select(pair => pair.Key)
            .Concat(config.Select(pair => pair.Key))
            .Distinct(StringComparer.Ordinal)
            .Where(key =>
                key is not ("access" or "channels" or "sessionAutoTitle" or "agentDefaultNode")
                && !JsonNode.DeepEquals(app[key], config[key])
            )
            .ToList();
        if (!JsonNode.DeepEquals(app["channels"]?["webui"], config["channels"]?["webui"]))
            restart.Add("channels.webui");
        var notApplied = new List<string>();
        if (access.Values.Any(identity => identity.Mcp) && !Access.McpRuntimeAvailable)
        {
            notApplied.Add("access.surfaces.mcp");
            restart.Add("access.surfaces.mcp");
        }
        var webhooks = access.Values.Any(identity => identity.Webhook is not null);
        if (webhooks && !Access.WebhookRuntimeAvailable)
        {
            notApplied.Add("access.surfaces.webhook");
            restart.Add("access.surfaces.webhook");
        }
        if (ManagedChannels is not null && restart.Contains("channels.webui"))
            notApplied.Add("channels.webui");
        if (
            ManagedChannels is null
            && (config.ContainsKey("channels") || app.ContainsKey("channels"))
        )
            notApplied.Add("channels");
        try
        {
            await Access.ApplyAsync(access);
        }
        catch (IOException)
        {
            notApplied.Add("access.connections");
        }
        var applied = Access.McpRuntimeAvailable
            ? new List<string> { "access.identities", "access.surfaces.mcp" }
            : new List<string> { "access.identities" };
        if (webhooks && Access.WebhookRuntimeAvailable)
            applied.Add("access.surfaces.webhook");
        var autoTitle = AppConfigurationRules.SessionAutoTitle(config);
        if (autoTitle != sessionAutoTitle)
            applied.Add("sessionAutoTitle");
        sessionAutoTitle = autoTitle;
        var nodeDefault = AppConfigurationRules.AgentDefaultNode(config);
        if (nodeDefault != agentDefaultNode)
            applied.Add("agentDefaultNode");
        agentDefaultNode = nodeDefault;
        JsonObject? reload = null;
        if (ManagedChannels is { } runtime)
        {
            reload = await runtime.ReloadAsync();
            applied.Add("channels");
            foreach (var status in (reload["statuses"] as JsonArray ?? []).OfType<JsonObject>())
                if (
                    SessionCatalog.Flag(status["enabled"])
                    && !SessionCatalog.Flag(status["running"])
                )
                    notApplied.Add("channels." + SessionWait.Text(status["channelId"]));
        }
        // Other Main app settings remain startup snapshots.
        var result = Installed("config", applied, notApplied, restart);
        if (reload is not null)
            result["reload"] = reload;
        return result;
    }

    // First-run Setup gives a new installation its initial app settings. An existing
    // config.yaml is never edited, and installations that pre-create models.yaml skip this.
    private async Task<bool> SeedAppAsync(CancellationToken token)
    {
        if (File.Exists(AppPath) || !File.Exists(AppTemplatePath))
            return false;
        await appPersistence.WaitAsync(token);
        try
        {
            if (File.Exists(AppPath))
                return false;
            var bytes = await File.ReadAllBytesAsync(AppTemplatePath, token);
            var seeded = ConfigurationYaml.Parse(
                new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'),
                "app config template"
            );
            AppConfigurationRules.Validate(seeded);
            var directory = Path.GetDirectoryName(AppPath)!;
            Directory.CreateDirectory(directory);
            var temporary = Path.Combine(
                directory,
                "." + Path.GetFileName(AppPath) + "." + Guid.NewGuid().ToString("N") + ".tmp"
            );
            try
            {
                await File.WriteAllBytesAsync(temporary, bytes, token);
                // Never replace a file created concurrently by another writer.
                File.Move(temporary, AppPath, false);
            }
            catch (IOException) when (File.Exists(AppPath))
            {
                return false;
            }
            finally
            {
                File.Delete(temporary);
            }
            sessionAutoTitle = AppConfigurationRules.SessionAutoTitle(seeded);
            agentDefaultNode = AppConfigurationRules.AgentDefaultNode(seeded);
            return true;
        }
        catch (Exception error) when (error is IOException or InvalidDataException)
        {
            // The models save already committed; a missing seed only leaves defaults.
            System.Diagnostics.Trace.TraceWarning(
                "Initial app configuration was not written: {0}",
                error.Message
            );
            return false;
        }
        finally
        {
            appPersistence.Release();
        }
    }

    private async Task<(
        JsonObject Config,
        System.Collections.Immutable.ImmutableDictionary<string, AccessIdentity> Access
    )> PersistAppAsync(
        Func<CancellationToken, Task<byte[]>> candidate,
        CancellationToken token,
        bool webhooksLocked = false
    )
    {
        // Only persistence is shared with direct command saves. Release before access/runtime
        // application, which may join a Weixin handler that is itself confirming a login.
        await appPersistence.WaitAsync(token);
        try
        {
            var bytes = await candidate(token);
            var raw = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF');
            var validated = await ValidateAppCandidateAsync(raw);
            if (webhooksLocked)
                RequireUnchangedWebhooks(validated.Access);
            await ReplaceRawAsync(AppPath, bytes, token);
            Secrets.Invalidate();
            return validated;
        }
        finally
        {
            appPersistence.Release();
        }
    }

    // Model-facing error copy; the coordinator owns its wording.
    internal const string WebhooksLockedError =
        "set_config cannot add or change webhook identities. Ask the user to configure webhooks in Setup.";

    /// <summary>
    /// Model-reachable saves may keep or remove webhook identities but not add or change one:
    /// a webhook is a public endpoint that can run unattended code, so only the user's Setup
    /// save or a direct file edit creates it. Compared with the saved file, not the live snapshot.
    /// </summary>
    private void RequireUnchangedWebhooks(
        System.Collections.Immutable.ImmutableDictionary<string, AccessIdentity> candidate
    )
    {
        System.Collections.Immutable.ImmutableDictionary<string, AccessIdentity> current;
        try
        {
            var saved = ConfigurationYaml.Parse(ReadCurrentAppRaw(), "app config");
            current = AccessConfiguration.Normalize(saved["access"], saved.ContainsKey("access"));
        }
        catch (InvalidDataException)
        {
            current = System
                .Collections
                .Immutable
                .ImmutableDictionary<string, AccessIdentity>
                .Empty;
        }
        foreach (var (id, identity) in candidate)
        {
            if (identity.Webhook is not { } hook)
                continue;
            if (
                !current.TryGetValue(id, out var existing)
                || existing.Webhook is not { } existingHook
                || !AccessConfiguration.Equal(existing.Token, identity.Token)
                || !existingHook.SameAs(hook)
            )
                throw new InvalidOperationException(WebhooksLockedError);
        }
    }

    private async Task<(
        JsonObject Config,
        System.Collections.Immutable.ImmutableDictionary<string, AccessIdentity> Access
    )> ValidateAppCandidateAsync(string raw)
    {
        var config = ConfigurationYaml.Parse(raw, "app config");
        AppConfigurationRules.Validate(config);
        var access = AccessConfiguration.Normalize(config["access"], config.ContainsKey("access"));
        Access.Validate(access);
        AccessConfiguration.Validate(
            access,
            await HttpServerSettings.ReadExistingTokenAsync(Paths.DataRoot) ?? ""
        );
        return (config, access);
    }

    internal static JsonObject Installed(
        string target,
        IEnumerable<string> applied,
        IEnumerable<string> notApplied,
        IEnumerable<string> restart
    ) =>
        new()
        {
            ["saved"] = true,
            ["target"] = target,
            ["applied"] = Strings(applied),
            ["notApplied"] = Strings(notApplied),
            ["restartRequired"] = Strings(restart),
        };

    private static JsonArray Strings(IEnumerable<string> values) =>
        new(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());

    private static async Task ReplaceRawAsync(
        string path,
        byte[] bytes,
        CancellationToken token,
        Action? publish = null
    )
    {
        var directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);
        var temporary = Path.Combine(
            directory,
            "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N") + ".tmp"
        );
        var renamed = false;
        try
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                Options = FileOptions.Asynchronous,
            };
            if (!OperatingSystem.IsWindows())
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            await using (var file = new FileStream(temporary, options))
            {
                await file.WriteAsync(bytes, token);
                file.Flush(true);
            }
            token.ThrowIfCancellationRequested();
            File.Move(temporary, path, true);
            renamed = true;
            publish?.Invoke();
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(directory);
        }
        catch (Exception error) when (renamed)
        {
            throw new AuthorityCommittedException(
                "Configuration committed but final durability failed.",
                error
            );
        }
        finally
        {
            if (!renamed)
            {
                try
                {
                    File.Delete(temporary);
                }
                catch { }
            }
        }
    }
}
