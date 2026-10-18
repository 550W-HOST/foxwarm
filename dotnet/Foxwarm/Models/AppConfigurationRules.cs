using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Models;

internal static class AppConfigurationRules
{
    private static readonly Regex ProviderId = new(
        "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        RegexOptions.CultureInvariant
    );
    private const int MaxNodeProviderTimeoutSeconds = 300;
    private const int MaxNodeProviderArgs = 64;
    private const int MaxNodeProviderValueLength = 4096;

    internal static void Validate(JsonObject app)
    {
        if (app.ContainsKey("url"))
            HttpUrl(app["url"], "app config `url`");
        Channels(app["channels"], app.ContainsKey("channels"));
        Llm(app["llm"]);
        NodeProviders(app["nodeProviders"], app.ContainsKey("nodeProviders"));
        SessionWorkers(app["sessionWorkers"], app.ContainsKey("sessionWorkers"));
        Boolean(app["dbWorkers"], "app config `dbWorkers`", app.ContainsKey("dbWorkers"));
        Vector(
            app["vector"],
            app.ContainsKey("vector"),
            app["llm"] is JsonObject llm ? llm["ollamaBaseUrl"] : null
        );
        VectorMaintenance(app["vectorMaintenance"], app.ContainsKey("vectorMaintenance"));
        AccessConfiguration.Normalize(app["access"], app.ContainsKey("access"));
        Boolean(
            app["handoffConfirmation"],
            "app config `handoffConfirmation`",
            app.ContainsKey("handoffConfirmation")
        );
    }

    private static void Channels(JsonNode? value, bool present)
    {
        if (!present)
            return;
        if (value is not JsonObject channels)
            throw new InvalidDataException("app config `channels` must be a YAML object.");
        foreach (var (id, raw) in channels)
        {
            if (raw is not JsonObject channel)
                throw new InvalidDataException($"app config channel `{id}` must be a YAML object.");
            ChannelProgress(channel["channelProgress"], channel.ContainsKey("channelProgress"), id);
        }
    }

    private static void ChannelProgress(JsonNode? value, bool present, string id)
    {
        if (
            !present
            || value is JsonValue scalar && scalar.TryGetValue<bool>(out var disabled) && !disabled
        )
            return;
        if (value is not JsonObject progress)
            throw new InvalidDataException(
                $"channels.{id}.channelProgress must be false or an object."
            );
        var interval = Number(progress["intervalMs"]);
        if (
            interval is null
            || interval < 30_000
            || interval > 1_800_000
            || Math.Truncate(interval.Value) != interval
        )
            throw new InvalidDataException(
                $"channels.{id}.channelProgress.intervalMs must be an integer between 30000 and 1800000."
            );
    }

    private static void Llm(JsonNode? value)
    {
        if (value is not JsonObject llm)
            return;
        HostModels.ValidateDefaults(llm, "llm");
        Fraction(
            llm,
            llm.ContainsKey("compactKeepPercent") ? "compactKeepPercent" : "compactPercent",
            llm.ContainsKey("compactKeepPercent") ? "compactKeepPercent" : "compactPercent"
        );
        Fraction(llm, "compactThresholdPercent", "compactThresholdPercent");
        if (llm.ContainsKey("providerImageOutputFormat"))
        {
            var format = Text(llm["providerImageOutputFormat"]);
            if (format is not ("webp" or "jpeg"))
                throw new InvalidDataException(
                    "app config `llm.providerImageOutputFormat` must be `webp` or `jpeg`."
                );
        }
    }

    private static void Fraction(JsonObject llm, string key, string errorKey)
    {
        var value = llm[key];
        if (value is null && !llm.ContainsKey(key))
            return;
        var number = Number(value);
        if (number is null || !double.IsFinite(number.Value) || number <= 0 || number > 1)
            throw new InvalidDataException(
                $"app config `llm.{errorKey}` must be a finite number greater than 0 and at most 1."
            );
    }

    private static void NodeProviders(JsonNode? value, bool present)
    {
        if (!present)
            return;
        if (value is not JsonObject providers)
            throw new InvalidDataException("app config `nodeProviders` must be an object.");
        foreach (var (id, raw) in providers)
        {
            if (!ProviderId.IsMatch(id))
                throw new InvalidDataException($"app config node provider id `{id}` is invalid.");
            if (raw is not JsonObject provider)
                throw new InvalidDataException(
                    $"app config `nodeProviders.{id}` must be an object."
                );
            var type = Text(provider["type"]);
            if (type is not ("executable" or "docker-worktree"))
                throw new InvalidDataException(
                    $"app config `nodeProviders.{id}.type` must be `executable` or `docker-worktree`."
                );
            var allowed =
                type == "docker-worktree"
                    ? new HashSet<string>([
                        "type",
                        "command",
                        "args",
                        "image",
                        "allowedWorktreeRoots",
                        "networkModes",
                        "stateDir",
                        "memory",
                        "cpus",
                        "pidsLimit",
                        "tmpfsSize",
                    ])
                    : new HashSet<string>(["type", "command", "args", "timeoutSeconds"]);
            var unknown = provider
                .Select(pair => pair.Key)
                .FirstOrDefault(key => !allowed.Contains(key));
            if (unknown is not null)
                throw new InvalidDataException(
                    $"app config `nodeProviders.{id}` has unsupported field `{unknown}`."
                );
            ExactText(
                provider["command"],
                $"app config `nodeProviders.{id}.command`",
                MaxNodeProviderValueLength
            );
            if (provider.ContainsKey("args") && provider["args"] is not JsonArray)
                throw new InvalidDataException(
                    $"app config `nodeProviders.{id}.args` must be an array of strings."
                );
            if (
                provider["args"] is JsonArray list
                && (
                    list.Count > MaxNodeProviderArgs
                    || list.Any(item =>
                        Text(item) is null
                        || Text(item)!.Length > MaxNodeProviderValueLength
                        || Text(item)!.Contains('\0')
                    )
                )
            )
                throw new InvalidDataException(
                    $"app config `nodeProviders.{id}.args` must contain at most {MaxNodeProviderArgs} bounded strings."
                );
            if (type == "executable")
            {
                var timeout = provider.ContainsKey("timeoutSeconds")
                    ? Number(provider["timeoutSeconds"])
                    : 90;
                if (
                    timeout is null
                    || timeout < 1
                    || timeout > MaxNodeProviderTimeoutSeconds
                    || Math.Truncate(timeout.Value) != timeout
                )
                    throw new InvalidDataException(
                        $"app config `nodeProviders.{id}.timeoutSeconds` must be an integer between 1 and {MaxNodeProviderTimeoutSeconds}."
                    );
            }
            else
            {
                ExactText(
                    provider["image"],
                    $"app config `nodeProviders.{id}.image`",
                    MaxNodeProviderValueLength
                );
                if (
                    provider["allowedWorktreeRoots"] is not JsonArray roots
                    || roots.Count == 0
                    || roots.Count > MaxNodeProviderArgs
                    || roots.Any(item =>
                        Text(item) is null
                        || Text(item)!.Length == 0
                        || Text(item)!.Length > MaxNodeProviderValueLength
                        || Text(item) != Text(item)!.Trim()
                    )
                )
                    throw new InvalidDataException(
                        $"app config `nodeProviders.{id}.allowedWorktreeRoots` must be a non-empty array of paths."
                    );
                if (
                    provider.ContainsKey("networkModes")
                    && (
                        provider["networkModes"] is not JsonArray networkModes
                        || networkModes.Count == 0
                        || networkModes.Any(item => Text(item) is not ("none" or "bridge"))
                    )
                )
                    throw new InvalidDataException(
                        $"app config `nodeProviders.{id}.networkModes` must contain only `none` or `bridge`."
                    );
                if (provider.ContainsKey("stateDir"))
                    ExactText(
                        provider["stateDir"],
                        $"app config `nodeProviders.{id}.stateDir`",
                        MaxNodeProviderValueLength
                    );
                var memory = provider.ContainsKey("memory") ? Text(provider["memory"]) : "2g";
                var tmpfs = provider.ContainsKey("tmpfsSize")
                    ? Text(provider["tmpfsSize"])
                    : "256m";
                if (memory is null || !Regex.IsMatch(memory, "^[1-9]\\d*[kKmMgG]$"))
                    throw new InvalidDataException(
                        $"app config `nodeProviders.{id}.memory` is invalid."
                    );
                if (tmpfs is null || !Regex.IsMatch(tmpfs, "^[1-9]\\d*[kKmMgG]$"))
                    throw new InvalidDataException(
                        $"app config `nodeProviders.{id}.tmpfsSize` is invalid."
                    );
                var cpus = provider.ContainsKey("cpus") ? Number(provider["cpus"]) : 2;
                var pids = provider.ContainsKey("pidsLimit") ? Number(provider["pidsLimit"]) : 256;
                if (cpus is null || !double.IsFinite(cpus.Value) || cpus <= 0 || cpus > 64)
                    throw new InvalidDataException(
                        $"app config `nodeProviders.{id}.cpus` must be between 0 and 64."
                    );
                if (pids is null || Math.Truncate(pids.Value) != pids || pids < 16 || pids > 65_536)
                    throw new InvalidDataException(
                        $"app config `nodeProviders.{id}.pidsLimit` must be an integer between 16 and 65536."
                    );
            }
        }
    }

    private static void SessionWorkers(JsonNode? value, bool present)
    {
        if (!present || value is JsonValue scalar && scalar.TryGetValue<bool>(out _))
            return;
        if (value is not JsonObject workers)
            throw new InvalidDataException(
                "app config `sessionWorkers` must be a boolean or object."
            );
        Boolean(
            workers["enabled"],
            "app config `sessionWorkers.enabled`",
            workers.ContainsKey("enabled")
        );
        var idle = workers.ContainsKey("idleSeconds") ? Number(workers["idleSeconds"]) : 60;
        if (idle is null || idle < 1 || idle > 86_400 || Math.Truncate(idle.Value) != idle)
            throw new InvalidDataException(
                "app config `sessionWorkers.idleSeconds` must be an integer between 1 and 86400."
            );
    }

    private static void Vector(JsonNode? value, bool present, JsonNode? legacy)
    {
        if (!present)
        {
            if (
                legacy is JsonValue legacyValue
                && legacyValue.TryGetValue<string>(out var legacyText)
                && legacyText.Trim().Length > 0
            )
                HttpUrl(legacy, "app config `llm.ollamaBaseUrl`");
            return;
        }
        if (value is JsonValue scalar && scalar.TryGetValue<bool>(out var disabled) && !disabled)
            return;
        if (value is not JsonObject vector)
            throw new InvalidDataException("app config `vector` must be false or an object.");
        Boolean(vector["enabled"], "app config `vector.enabled`", vector.ContainsKey("enabled"));
        Boolean(
            vector["lexicalIndex"],
            "app config `vector.lexicalIndex`",
            vector.ContainsKey("lexicalIndex")
        );
        Boolean(
            vector["hybridSearch"],
            "app config `vector.hybridSearch`",
            vector.ContainsKey("hybridSearch")
        );
        if (
            vector["enabled"] is not JsonValue enabled
            || !enabled.TryGetValue<bool>(out var on)
            || on
        )
            HttpUrl(vector["baseUrl"], "app config `vector.baseUrl`");
        else if (vector.ContainsKey("baseUrl"))
            HttpUrl(vector["baseUrl"], "app config `vector.baseUrl`");
    }

    private static void VectorMaintenance(JsonNode? value, bool present)
    {
        if (!present || value is JsonValue scalar && scalar.TryGetValue<bool>(out _))
            return;
        if (value is not JsonObject maintenance)
            throw new InvalidDataException(
                "app config `vectorMaintenance` must be a boolean or object."
            );
        Boolean(
            maintenance["enabled"],
            "app config `vectorMaintenance.enabled`",
            maintenance.ContainsKey("enabled")
        );
        var hours = maintenance.ContainsKey("retentionHours")
            ? Number(maintenance["retentionHours"])
            : 24;
        if (hours is null || hours < 1 || Math.Truncate(hours.Value) != hours)
            throw new InvalidDataException(
                "app config `vectorMaintenance.retentionHours` must be a positive integer."
            );
    }

    private static void Boolean(JsonNode? value, string label, bool present)
    {
        if (!present)
            return;
        if (value is not JsonValue scalar || !scalar.TryGetValue<bool>(out _))
            throw new InvalidDataException(label + " must be a boolean.");
    }

    private static void ExactText(JsonNode? value, string label, int maxLength)
    {
        var text = Text(value);
        if (
            text is null
            || text.Length == 0
            || text != text.Trim()
            || text.Length > maxLength
            || text.Any(character => character <= '\u001f' || character == '\u007f')
        )
            throw new InvalidDataException(label + " must be an exact non-empty string.");
    }

    private static void HttpUrl(JsonNode? value, string label)
    {
        var text = Text(value)?.Trim();
        if (
            text is null
            || text.Length == 0
            || text.Any(char.IsControl)
            || text.Contains('\\')
            || !Uri.TryCreate(text, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || uri.Host.Length == 0
            || uri.UserInfo.Length > 0
            || uri.Query.Length > 0
            || uri.Fragment.Length > 0
        )
            throw new InvalidDataException(
                label + " must be an absolute http(s) URL without credentials, query, or fragment."
            );
    }

    private static string? Text(JsonNode? value) =>
        value is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : null;

    private static double? Number(JsonNode? value) =>
        value is JsonValue scalar && scalar.TryGetValue<double>(out var number) ? number : null;
}
