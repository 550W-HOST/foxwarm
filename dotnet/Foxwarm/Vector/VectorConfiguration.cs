using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Vector;

internal sealed record VectorConfiguration(
    bool Enabled,
    string? BaseUrl,
    bool LexicalIndex,
    bool HybridSearch,
    bool DbWorkers,
    bool MaintenanceEnabled,
    double RetentionHours,
    string Source
)
{
    internal static VectorConfiguration Capture(JsonObject? app)
    {
        app ??= new();
        var workers = app["dbWorkers"]?.GetValue<bool>() ?? true;
        var maintenance = app["vectorMaintenance"];
        var maintenanceEnabled = maintenance is JsonObject m
            ? m["enabled"]?.GetValue<bool>() != false
            : maintenance?.GetValue<bool>() != false;
        var retention = maintenance is JsonObject settings
            ? SessionWait.Number(settings["retentionHours"]) ?? 24
            : 24;
        VectorConfiguration Result(
            bool enabled,
            string? url,
            bool lexical,
            bool hybrid,
            string source
        ) =>
            new(
                enabled,
                url,
                lexical,
                lexical && hybrid,
                workers,
                maintenanceEnabled,
                retention,
                source
            );
        if (!app.ContainsKey("vector"))
        {
            var legacy = SessionWait.Text((app["llm"] as JsonObject)?["ollamaBaseUrl"]);
            if (legacy is null || SessionGoal.Trim(legacy).Length == 0)
                return Result(false, null, false, false, "disabled-default");
            var uri = new UriBuilder(SessionGoal.Trim(legacy).TrimEnd('/'));
            var path = uri.Path.TrimEnd('/');
            if (!path.EndsWith("/v1", StringComparison.Ordinal))
                uri.Path = path + "/v1";
            return Result(true, uri.Uri.AbsoluteUri.TrimEnd('/'), false, false, "legacy-ollama");
        }
        if (app["vector"] is not JsonObject vector)
            return Result(false, null, false, false, "vector");
        var enabled = vector["enabled"]?.GetValue<bool>() != false;
        return Result(
            enabled,
            SessionWait.Text(vector["baseUrl"]) is { } root
                ? SessionGoal.Trim(root).TrimEnd('/')
                : null,
            enabled && vector["lexicalIndex"]?.GetValue<bool>() == true,
            enabled && vector["hybridSearch"]?.GetValue<bool>() == true,
            "vector"
        );
    }
}

internal sealed class VectorUnavailableException(string code, string message)
    : InvalidOperationException(message)
{
    internal string Code { get; } = code;
}
