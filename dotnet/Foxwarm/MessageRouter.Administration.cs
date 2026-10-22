using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task HandleForkCommandAsync(
        ExternalChannelContext source,
        string? rawArgs,
        SessionOwner owner
    )
    {
        var parsed = Regex.Match(rawArgs ?? "", @"^(\S+)(?:\s+([\s\S]*))?$");
        var suffix = parsed.Success ? parsed.Groups[1].Value : runtime.Manager.GenerateSessionId();
        var initial =
            parsed.Groups[2].Success && parsed.Groups[2].Value.Length > 0
                ? parsed.Groups[2].Value
                : null;
        try
        {
            var requested =
                owner.Id.Split('/').Last() == "main"
                    ? SessionIdentity.Build(owner.Agent, suffix)
                    : owner.Id + "_" + suffix;
            if (runtime.Catalog.Get(requested) is not null)
            {
                await source.Reply($"❌ Session `{requested}` already exists.");
                return;
            }
            var child = await runtime.ForkCommandAsync(owner.Id, suffix, initial);
            await source.Reply(
                $"✅ Forked session `{owner.Id}` → `{child.Id}`"
                    + (initial is null ? "" : "\nInitial message sent.")
            );
        }
        catch (Exception error)
        {
            await source.Reply("❌ Fork failed: " + error.Message);
        }
    }

    private async Task HandleModelCommandAsync(
        ExternalChannelContext source,
        string[] args,
        SessionOwner owner,
        bool child
    )
    {
        var parsed = CommandArguments.Effort(args);
        if (parsed.Remaining.Length > 1)
        {
            await source.Reply(
                child
                    ? "Usage: /session child-model [model|default] [--effort <level|default|unset>]"
                    : "Usage: /model [name|default] [--effort <level|default|unset>]"
            );
            return;
        }
        var patch = new JsonObject();
        if (parsed.Present)
            patch[child ? "childEffortDefault" : "effort"] = parsed.Effort;
        if (parsed.Remaining.FirstOrDefault() is { } target)
        {
            var clear = child
                ? new[] { "default", "clear", "unset" }.Contains(target.ToLowerInvariant())
                : target == "default";
            patch[child ? "childModelDefault" : "model"] = clear
                ? null
                : CommandArguments.ResolveModel(target, runtime.Manager.Models);
        }
        if (patch.Count > 0)
            await owner.Entry.SaveLane.CommitSettingsAsync(patch, runtime.Manager.Models);
        var dto = owner.BuildDto();
        var models = runtime.Manager.Models.Capture();
        var rawModel = owner.Metadata().Model;
        var currentKey =
            rawModel is not null && models.Contains(rawModel) ? rawModel : models.DefaultKey;
        var current = models.All.Count == 0 ? null : models.Resolve(currentKey);
        var lines = child
            ? new List<string>
            {
                "🧒 *Child model / effort defaults*",
                $"- model override: {(SessionWait.Text(dto["childModelDefault"]) is { } model ? "`" + model + "`" : "follow current")}",
                $"- policy source: {dto["childModelPolicySource"]}",
                $"- effective model: `{dto["effectiveChildModelKey"]}`",
                $"- effort override: {SessionWait.Text(dto["childEffortDefault"]) ?? "unset"}",
                $"- effective effort: {dto["effectiveChildEffort"]}",
            }
            : new List<string>
            {
                "🤖 *Model / Effort*",
                $"- model: `{currentKey}` (raw: {(rawModel is { } raw ? "`" + raw + "`" : "default")})",
                $"- effort: raw={owner.Metadata().Effort ?? "unset"}, effective={SessionWait.Text(dto["effectiveEffort"]) ?? "per-leaf default"}",
                "- allowed: " + string.Join(", ", current?.AllowedEfforts ?? HostModels.Efforts),
                "- model default: " + (current?.DefaultEffort ?? "per-leaf default"),
            };
        if (!child && args.Length == 0)
        {
            lines.AddRange(["", "*Models*"]);
            foreach (var option in models.Options)
            {
                var tags = new[]
                {
                    option.Key == models.DefaultKey ? "default" : null,
                    option.Key == currentKey ? "current" : null,
                }
                    .OfType<string>()
                    .ToArray();
                lines.Add(
                    $"- `{option.Key}`"
                        + (tags.Length == 0 ? "" : " (" + string.Join(", ", tags) + ")")
                );
            }
        }
        await source.Reply(string.Join("\n", lines));
    }

    private async Task HandleSearchCommandAsync(
        ExternalChannelContext source,
        string[] args,
        SessionOwner owner
    )
    {
        var request = new JsonObject { ["limit"] = 5 };
        var query = new List<string>();
        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            if (index + 1 < args.Length && arg is "--limit" or "--session" or "--agent")
            {
                var value = args[++index];
                if (arg == "--limit")
                {
                    if (CommandArguments.Integer(value) is > 0 and var limit)
                        request["limit"] = limit;
                }
                else
                    request[arg == "--session" ? "sessionId" : "agentName"] = value;
            }
            else
                query.Add(arg);
        }
        if (query.Count == 0)
        {
            await source.Reply(
                "Usage: /search [--session <session-id>] [--agent <agent-name>] [--limit <n>] <query>"
            );
            return;
        }
        request["vector_query"] = string.Join(" ", query);
        var result = await ArchiveRecallTool.ExecuteAsync(runtime.Manager, owner, request);
        await source.Reply(
            SessionWait.Text(result["output"])
                ?? "❌ Search failed: "
                    + (SessionWait.Text(result["error"]?["message"]) ?? "Search unavailable.")
        );
    }

    private async Task HandleMessagesCommandAsync(
        ExternalChannelContext source,
        string[] args,
        SessionOwner owner
    )
    {
        var history = owner.History();
        var total = history.Count;
        if (
            CommandArguments.Integer(args.FirstOrDefault()) is not { } first
            || args.Length == 1 && first == 0
            || args.Length > 1 && CommandArguments.Integer(args[1]) is null
        )
        {
            await source.Reply("Usage: `/messages <num>` | `/messages <start> <end>`");
            return;
        }
        var start =
            args.Length == 1
                ? first > 0
                    ? 0
                    : Math.Max(0, total + first)
                : Math.Clamp(first < 0 ? total + first : first, 0, total);
        var second = args.Length > 1 ? CommandArguments.Integer(args[1])!.Value : 0;
        var end =
            args.Length == 1
                ? first > 0
                    ? Math.Min(first, total)
                    : total
                : Math.Clamp(second < 0 ? total + second : second, 0, total);
        if (end < start)
        {
            await source.Reply("No messages found in the specified range.");
            return;
        }
        var selected = history.Skip(start).Take(end - start).ToArray();
        if (selected.Length == 0)
        {
            await source.Reply(
                $"No messages found in session `{owner.Id}` (total: {total} messages)."
            );
            return;
        }
        await source.Reply(
            ContextPreviewRenderer.CommandMessages(owner.Id, total, start, selected)
        );
    }
}
