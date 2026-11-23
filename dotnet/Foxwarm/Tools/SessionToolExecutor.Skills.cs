using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
{
    // `ctl skill run`: the entry is read through the skill subsystem on the Main server (never a
    // Node read), its args are checked against the skill's schema, and it then runs exactly as
    // an inline run_script with the caller's authority. Every nested call keeps its own gate.
    private async Task<JsonObject> ExecuteRunSkillAsync(JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["skillName", "args", "mode", "timeoutSecs", "agentName"]);
        var name =
            SessionWait.Text(args["skillName"])?.Trim() is { Length: > 0 } skillName
                ? skillName
                : throw new InvalidDataException("skillName is required.");
        var agent = Skills.RequestedAgent(SessionWait.Text(args["agentName"]), hosted.Agent);
        var entry = await sessions.SkillCatalog.ReadEntryAsync(name, agent, token);
        var input = args["args"] ?? new JsonObject();
        try
        {
            Skills.ValidateArgs(entry.Run.Args, input);
        }
        catch (InvalidDataException error)
        {
            throw new InvalidDataException(
                $"Invalid arguments for skill `{entry.Info.Name}`: {error.Message} `ctl skill run {entry.Info.Name} --help` lists them."
            );
        }
        var start = new JsonObject
        {
            ["code"] = entry.Code,
            ["args"] = input.DeepClone(),
            ["mode"] = SessionWait.Text(args["mode"]) ?? entry.Run.Mode,
        };
        if (args["timeoutSecs"] is { } timeout)
            start["timeoutSecs"] = timeout.DeepClone();
        else if (entry.Run.TimeoutSecs is { } seconds)
            start["timeoutSecs"] = seconds;
        return await ExecuteToolScriptAsync("run_skill", start, token, entry);
    }
}
