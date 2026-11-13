using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

// Builds ctl call arguments for tests that exercise the generic `tool call` and `tool search`
// commands with the descriptor and search fields the former unified tools took.
internal static class CtlTestArgs
{
    // The target arguments of a ctl command hint in tool output, such as an older-page link.
    internal static JsonObject Hint(string text, string builtin)
    {
        var parsed = Foxwarm.Tools.CtlParser.Parse(new JsonObject { ["command"] = text });
        if (parsed is Foxwarm.Tools.CtlError error)
            Xunit.Assert.Fail(text + ": " + error.Message);
        var target = Xunit.Assert.IsType<Foxwarm.Tools.CtlTarget>(parsed);
        Xunit.Assert.Equal(builtin, target.Name);
        // Reparse so numbers read as any integer type, like JSON arguments.
        var args = JsonNode.Parse(target.Args.ToJsonString())!.AsObject();
        foreach (var key in target.Command.Fixed?.Select(pair => pair.Key) ?? [])
            args.Remove(key);
        return args;
    }

    private static string Quote(string text) =>
        "'" + text.Replace("'", "'\\''", StringComparison.Ordinal) + "'";

    // A `tool call` command for a descriptor: toolId or source/name/server/nodeId, with args or argsJson.
    internal static JsonObject Unified(JsonObject descriptor)
    {
        var words = new List<string> { "tool", "call" };
        var result = new JsonObject();
        foreach (var (key, value) in descriptor)
            switch (key)
            {
                case "toolId":
                    words.Insert(2, Quote(value!.GetValue<string>()));
                    break;
                case "source":
                case "name":
                case "server":
                    words.Add("--" + key);
                    words.Add(Quote(value!.GetValue<string>()));
                    break;
                case "nodeId":
                    words.Add("--node-id");
                    words.Add(Quote(value!.GetValue<string>()));
                    break;
                case "args":
                    words.Add("--args");
                    words.Add("@args");
                    result["values"] = new JsonObject { ["args"] = value?.DeepClone() };
                    break;
                case "argsJson":
                    words.Add("--args");
                    words.Add("@args");
                    result["valuesJson"] = "{\"args\":" + value!.GetValue<string>() + "}";
                    break;
                default:
                    // Model controls such as __cancelTool stay on the ctl call itself.
                    result[key] = value?.DeepClone();
                    break;
            }
        result["command"] = string.Join(' ', words);
        return result;
    }

    // A `tool search` command for the former search fields.
    internal static JsonObject Search(JsonObject search)
    {
        var words = new List<string> { "tool", "search" };
        string? query = null;
        foreach (var (key, value) in search)
            switch (key)
            {
                case "query":
                    query = value!.GetValue<string>();
                    break;
                case "sources":
                    foreach (
                        var source in value is JsonArray list
                            ? list.Select(item => item!.GetValue<string>())
                            : [value!.GetValue<string>()]
                    )
                    {
                        words.Add("--source");
                        words.Add(source);
                    }
                    break;
                case "server":
                    words.Add("--server");
                    words.Add(Quote(value!.GetValue<string>()));
                    break;
                case "nodeId":
                    words.Add("--node-id");
                    words.Add(Quote(value!.GetValue<string>()));
                    break;
                case "limit":
                    words.Add("--limit=" + value!.ToJsonString());
                    break;
                case "includeSchema":
                    words.Add(value!.GetValue<bool>() ? "--schema" : "--no-schema");
                    break;
                default:
                    throw new ArgumentException("Unsupported search field " + key);
            }
        if (query is not null)
        {
            words.Add("--");
            words.Add(Quote(query));
        }
        return new JsonObject { ["command"] = string.Join(' ', words) };
    }

    // A function call object for the model: ctl with the given command.
    internal static JsonObject Command(string command, JsonObject? values = null)
    {
        var result = new JsonObject { ["command"] = command };
        if (values is not null)
            result["values"] = values;
        return result;
    }
}
