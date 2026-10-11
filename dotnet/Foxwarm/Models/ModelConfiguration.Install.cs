using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using YamlDotNet.Serialization;

namespace Foxwarm.Models;

internal sealed partial class ModelConfiguration
{
    internal Task<JsonObject> SaveAsync(JsonObject input) =>
        InstallAsync("models", _ => Task.FromResult(Encoding.UTF8.GetBytes(
            input.ContainsKey("yaml") ? JsString(input["yaml"]) : BuildForm(input)
        )));

    internal Task<JsonObject> SaveAppAsync(string raw) =>
        InstallAsync("config", _ => Task.FromResult(Encoding.UTF8.GetBytes(raw)));

    internal Task<JsonObject> SaveChannelsAsync(JsonObject channels) =>
        InstallAsync("config", _ =>
        {
            var currentRaw = ReadCurrentAppRaw();
            var current = ConfigurationYaml.Parse(currentRaw, "app config");
            AppConfigurationRules.Validate(current);
            var serialized = new SerializerBuilder().Build()
                .Serialize(JsonNodeToObject(channels)).TrimEnd();
            var section = serialized.Length == 0 || serialized == "{}"
                ? "channels: {}"
                : "channels:\n" + string.Join("\n", serialized.Split('\n')
                    .Select(line => line.Length == 0 ? line : "  " + line));
            return Task.FromResult(Encoding.UTF8.GetBytes(
                ReplaceTopLevelSection(currentRaw, "channels", section)
            ));
        });

    // Every candidate factory and section read runs after prior installations settle.
    internal async Task<JsonObject> InstallAsync(
        string target,
        Func<CancellationToken, Task<byte[]>> candidate,
        ToolAuthorizationAuthority? authorization = null,
        Func<CancellationToken, Task>? authorize = null,
        CancellationToken token = default
    )
    {
        await mutation.WaitAsync(token);
        try
        {
            if (authorize is not null) await authorize(token);
            token.ThrowIfCancellationRequested();
            var bytes = await candidate(token);
            if (target == "tool-rules")
            {
                if (authorization is null)
                    throw new InvalidOperationException("Tool authorization installation is unavailable.");
                await authorization.InstallAsync(bytes, token);
                return Installed(target, ["tool-rules"], [], []);
            }
            var raw = new UTF8Encoding(false, true).GetString(bytes);
            // UTF-8 BOM is preserved in the installed bytes, but is not part of YAML.
            if (raw.StartsWith('\uFEFF')) raw = raw[1..];
            if (target == "models")
            {
                var next = Validate(raw);
                await ReplaceRawAsync(ActivePath, bytes, token, () =>
                {
                    lock (gate)
                    {
                        catalog = next;
                        cachedRaw = raw;
                    }
                });
                return Installed(target, ["models"], [], []);
            }
            if (target != "config") throw new InvalidDataException("Unknown configuration target.");
            var config = ConfigurationYaml.Parse(raw, "app config");
            AppConfigurationRules.Validate(config);
            var restart = app.Select(pair => pair.Key).Concat(config.Select(pair => pair.Key))
                .Distinct(StringComparer.Ordinal)
                .Where(key => key is not ("access" or "channels") && !JsonNode.DeepEquals(app[key], config[key]))
                .ToList();
            if (!JsonNode.DeepEquals(app["channels"]?["webui"], config["channels"]?["webui"]))
                restart.Add("channels.webui");
            var notApplied = new List<string>();
            if (config.ContainsKey("access") || app.ContainsKey("access")) notApplied.Add("access.identities");
            if (config.ContainsKey("channels") || app.ContainsKey("channels")) notApplied.Add("channels");
            await ReplaceRawAsync(AppPath, bytes, token);
            // Main app settings are startup snapshots; unsupported modules are never claimed as applied.
            return Installed(target, [], notApplied, restart);
        }
        finally
        {
            mutation.Release();
        }
    }

    internal static JsonObject Installed(
        string target,
        IEnumerable<string> applied,
        IEnumerable<string> notApplied,
        IEnumerable<string> restart
    ) => new()
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
        var temporary = Path.Combine(directory, "." + Path.GetFileName(path) + "." + Guid.NewGuid().ToString("N") + ".tmp");
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
            throw new AuthorityCommittedException("Configuration committed but final durability failed.", error);
        }
        finally
        {
            if (!renamed)
            {
                try { File.Delete(temporary); }
                catch { }
            }
        }
    }
}
