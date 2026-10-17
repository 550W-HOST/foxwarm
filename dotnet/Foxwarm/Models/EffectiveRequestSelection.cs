using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed record EffectiveRequestSelection(
    string ModelId,
    string NodeId,
    string Effort,
    string? MissingModelKey = null
)
{
    internal static EffectiveRequestSelection? Read(JsonNode? value)
    {
        if (value is not JsonObject obj)
            return null;
        var model = SessionWait.Text(value["modelId"]);
        var node = SessionWait.Text(obj["nodeId"]);
        var effort = SessionWait.Text(obj["effort"]);
        if (
            string.IsNullOrEmpty(model)
            || string.IsNullOrEmpty(node)
            || effort is null
            || !HostModels.Efforts.Contains(effort)
            || obj.ContainsKey("missingModelKey")
                && SessionWait.Text(obj["missingModelKey"]) is null
        )
            return null;
        return new(model, node, effort, SessionWait.Text(obj["missingModelKey"]));
    }

    internal JsonObject ToJson()
    {
        var value = new JsonObject
        {
            ["modelId"] = ModelId,
            ["nodeId"] = NodeId,
            ["effort"] = Effort,
        };
        if (MissingModelKey is not null)
            value["missingModelKey"] = MissingModelKey;
        return value;
    }

    internal JsonObject? Notice(EffectiveRequestSelection? previous, bool failover)
    {
        var modelChanged = previous is not null && previous.ModelId != ModelId;
        var nodeChanged = previous is not null && previous.NodeId != NodeId;
        var missingChanged =
            !string.IsNullOrEmpty(MissingModelKey)
            && (modelChanged || previous?.MissingModelKey != MissingModelKey);
        if (!modelChanged && !nodeChanged && !missingChanged)
            return null;
        var attrs = new Dictionary<string, string>
        {
            ["kind"] = "session-settings-changed",
            ["reason"] =
                missingChanged ? "missing-model"
                : modelChanged && failover ? "failover"
                : "effective-selection",
            ["modelId"] = ModelId,
            ["effectiveEffort"] = Effort,
        };
        if (modelChanged)
        {
            attrs["oldModel"] = previous!.ModelId;
            attrs["newModel"] = ModelId;
            attrs["oldEffort"] = previous.Effort;
            attrs["newEffort"] = Effort;
        }
        if (nodeChanged)
        {
            attrs["oldNode"] = previous!.NodeId;
            attrs["newNode"] = NodeId;
        }
        if (missingChanged)
        {
            attrs["requestedModel"] = MissingModelKey!;
            attrs["fallback"] = "global-default";
        }
        attrs["time"] = ArchiveBlockRecord.LocalTimestamp(
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        );
        return new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["system"] =
                        "<foxwarm-system "
                        + string.Join(
                            " ",
                            attrs.Select(pair =>
                                pair.Key
                                + "=\""
                                + LocalSessionTurnHost.EscapeFoxwarmAttribute(pair.Value)
                                + "\""
                            )
                        )
                        + " />",
                }
            ),
        };
    }
}
