using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed partial class ModelConfiguration
{
    private string BuildForm(JsonObject input)
    {
        var existing = File.Exists(ActivePath)
            ? ConfigurationYaml.Parse(File.ReadAllText(ActivePath), "models config")
            : new JsonObject();
        var rootKey =
            existing["providers"] is not null ? "providers"
            : existing["models"] is not null ? "models"
            : "providers";
        var old = existing[rootKey] as JsonObject ?? new JsonObject();
        var next = new JsonObject();
        var drafts =
            input["providers"] as JsonArray
            ?? throw new InvalidDataException("Models setup requires providers array.");
        string[] Split(JsonNode? node) =>
            node is JsonArray array
                ? array
                    .Select(JsString)
                    .Select(value => value.Trim())
                    .Where(value => value.Length > 0)
                    .ToArray()
                : JsString(node)
                    .Split(['\n', ','], StringSplitOptions.RemoveEmptyEntries)
                    .Select(value => value.Trim())
                    .Where(value => value.Length > 0)
                    .ToArray();
        foreach (var draftNode in drafts)
        {
            var draft =
                draftNode as JsonObject
                ?? throw new InvalidDataException("Provider draft must be an object.");
            var key = JsString(draft["id"]).Trim();
            if (key.Length == 0)
                continue;
            if (next.ContainsKey(key))
                throw new InvalidDataException("Provider IDs must be unique.");
            var previous = old[key] as JsonObject ?? new JsonObject();
            var config = (JsonObject)previous.DeepClone();
            var type =
                HostModels.Text(draft, "providerType")
                ?? HostModels.Text(previous, "providerType")
                ?? HostModels.Text(previous, "provider")
                ?? "openai-completions";
            config["providerType"] = type;
            config.Remove("provider");
            if (type is "session-hash" or "failover")
            {
                config["targets"] = new JsonArray(
                    Split(draft.ContainsKey("targets") ? draft["targets"] : previous["targets"])
                        .Select(value => (JsonNode?)JsonValue.Create(value))
                        .ToArray()
                );
                foreach (
                    var field in new[]
                    {
                        "models",
                        "model",
                        "baseUrl",
                        "apiKey",
                        "requestCompression",
                        "extraFields",
                        "extraHeaders",
                        "webSearch",
                        "imageGeneration",
                        "contextLimit",
                        "maxOutput",
                        "providerImageOutputFormat",
                        "streamContentInactivityTimeoutMs",
                        "effort",
                        "historyReasoningField",
                        "asyncCompact",
                        "disallowEmptyResponse",
                        "keepReasoningOnError",
                    }
                )
                    config.Remove(field);
                foreach (var field in new[] { "failureThreshold", "cooldownMs" })
                {
                    var value = JsString(draft[field]).Trim();
                    if (type == "session-hash")
                    {
                        if (draft.ContainsKey(field) && value.Length > 0)
                            throw new InvalidDataException("Session-hash forbids failover fields.");
                        config.Remove(field);
                    }
                    else if (draft.ContainsKey(field))
                    {
                        if (value.Length == 0)
                            config.Remove(field);
                        else
                            config[field] =
                                int.TryParse(
                                    value,
                                    NumberStyles.Integer,
                                    CultureInfo.InvariantCulture,
                                    out var number
                                )
                                && number > 0
                                    ? number
                                    : throw new InvalidDataException(
                                        field + " must be a positive integer."
                                    );
                    }
                }
            }
            else
            {
                foreach (var field in new[] { "targets", "failureThreshold", "cooldownMs" })
                    config.Remove(field);
                var ids = Split(draft.ContainsKey("models") ? draft["models"] : draft["model"]);
                if (ids.Length == 0)
                    throw new InvalidDataException("Provider requires at least one model id.");
                foreach (var field in new[] { "baseUrl", "apiKey" })
                    if (draft.ContainsKey(field))
                    {
                        var value = JsString(draft[field]).Trim();
                        if (value.Length == 0)
                            config.Remove(field);
                        else
                            config[field] = value;
                    }
                var oldMembers = previous["models"] ?? previous["model"];
                var members =
                    oldMembers is JsonArray list ? list.ToArray()
                    : oldMembers is null ? []
                    : new[] { oldMembers };
                config["models"] = new JsonArray(
                    ids.Select(id =>
                        {
                            var preserved = members
                                .OfType<JsonObject>()
                                .FirstOrDefault(item => SessionWait.Text(item["id"])?.Trim() == id);
                            var result = preserved?.DeepClone() ?? JsonValue.Create(id);
                            if (type != "openai-completions" && result is JsonObject obj)
                                obj.Remove("historyReasoningField");
                            return result;
                        })
                        .ToArray()
                );
                config.Remove("model");
                if (type != "openai-completions")
                    config.Remove("historyReasoningField");
            }
            next[key] = config;
        }
        if (next.Count == 0)
            throw new InvalidDataException("At least one provider is required.");
        var first = next.First();
        var firstModel = (first.Value?["models"] as JsonArray)?.FirstOrDefault();
        var firstId = SessionWait.Text(firstModel) ?? SessionWait.Text(firstModel?["id"]);
        var fallback = firstId is null ? first.Key : first.Key + "/" + firstId;
        existing["default"] =
            HostModels.Text(input, "defaultModel") ?? HostModels.Text(input, "default") ?? fallback;
        existing[rootKey] = next;
        // JSON is YAML 1.2; raw mode is never regenerated through this form writer.
        return existing.ToJsonString(
                new System.Text.Json.JsonSerializerOptions { WriteIndented = true }
            ) + "\n";
    }
}
