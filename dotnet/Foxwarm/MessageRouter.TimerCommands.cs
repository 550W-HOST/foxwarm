using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Timers;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task HandleTimerCommandAsync(
        ExternalChannelContext source,
        string[] args,
        SessionOwner owner
    )
    {
        static string Date(JsonNode? value) =>
            SessionWait.Number(value) is > 0 and var stamp
                ? DateTimeOffset
                    .FromUnixTimeMilliseconds((long)stamp)
                    .ToString(
                        "yyyy-MM-dd\'T\'HH:mm:ss.fff\'Z\'",
                        System.Globalization.CultureInfo.InvariantCulture
                    )
                : "n/a";
        static string Action(JsonObject timer) =>
            TimerArguments.Script(timer)
                ? "ToolScript ("
                    + (
                        SessionWait.Text(timer["script"]?["code"]) is { Length: > 0 }
                            ? "inline"
                            : (SessionWait.Text(timer["script"]?["node"]) ?? "current")
                                + ": "
                                + SessionWait.Text(timer["script"]?["filePath"])
                    )
                    + ")"
                : SessionWait.Text(timer["message"]) ?? "";
        var sub = args.FirstOrDefault();
        var manager = runtime.Manager;
        if (sub is null)
        {
            var tree = ExternalCommands.Find("/timer")!["autocomplete"]!["children"]!.AsArray();
            await source.Reply(
                "⏰ *Timer Commands*\n\n"
                    + string.Join(
                        "\n",
                        tree.OfType<JsonObject>()
                            .Select(row =>
                                $"`{SessionWait.Text(row["usage"]) ?? "/timer " + row["value"]}` - {row["description"]}"
                            )
                    )
            );
            return;
        }
        if (sub == "list")
        {
            var list = manager.Timers.List(owner.Id);
            await source.Reply(
                list.Count == 0
                    ? "No timers found for this session."
                    : $"⏰ *Timers for session `{owner.Id}`*\n\n"
                        + string.Join(
                            "",
                            list.OfType<JsonObject>()
                                .Select(timer =>
                                    $"- `{timer["id"]}` - "
                                    + (
                                        SessionWait.Text(timer["mode"]) == "cron"
                                            ? $"cron: `{timer["cron"]}`"
                                            : "at: " + Date(timer["at"])
                                    )
                                    + " - next: "
                                    + Date(timer["nextRunAt"])
                                    + " - "
                                    + (
                                        SessionCatalog.Flag(timer["newSession"])
                                            ? $"new session ({SessionWait.Text(timer["agentName"]) ?? "main"} / {SessionWait.Text(timer["sessionPrefix"]) ?? "timer"})"
                                            : "this session"
                                    )
                                    + $"\n  {Action(timer)}\n"
                                )
                        )
            );
            return;
        }
        if (sub == "delete")
        {
            if (args.Length < 2)
            {
                await source.Reply("Usage: /timer delete <id>");
                return;
            }
            var result = await manager.ExecuteTimerCommandAsync(
                owner,
                "delete_timer",
                new JsonObject { ["timerId"] = args[1] }
            );
            if (result["error"] is not null)
            {
                await source.Reply(
                    "❌ "
                        + SessionWait.Text(result["error"]?["message"])
                        + (
                            SessionCatalog.Flag(result["timerCommitted"])
                                ? $" Timer `{result["timerId"]}` change was committed."
                                : ""
                        )
                );
                return;
            }
            await source.Reply(
                SessionCatalog.Flag(result["deleted"])
                    ? $"✅ Timer `{args[1]}` deleted."
                    : $"❌ Timer `{args[1]}` not found."
            );
            return;
        }
        if (sub is not ("after" or "at" or "cron"))
        {
            await source.Reply("Unknown timer subcommand. Use `/timer` for help.");
            return;
        }
        var schedule = args.ElementAtOrDefault(1);
        var usage = ExternalCommands.Find("/timer")!["autocomplete"]!["children"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(row => SessionWait.Text(row["value"]) == sub)["usage"]!.GetValue<string>();
        if (schedule is null || sub == "after" && CommandArguments.Integer(schedule) is not > 0)
        {
            await source.Reply("Usage: " + usage);
            return;
        }
        var request = new JsonObject();
        if (sub == "after")
            request["afterSeconds"] = CommandArguments.Integer(schedule);
        else
            request[sub == "at" ? "at" : "cron"] = schedule;
        var index = 2;
        while (index < args.Length)
        {
            if (args[index] == "--new-session")
            {
                request["newSession"] = true;
                index++;
                continue;
            }
            if (args[index] is "--prefix" or "--agent")
            {
                var flag = args[index++];
                if (index == args.Length)
                    throw new InvalidDataException("Missing value for " + flag);
                request[flag == "--prefix" ? "sessionPrefix" : "agentName"] = args[index++];
                continue;
            }
            break;
        }
        if (args.ElementAtOrDefault(index) == "--")
            index++;
        var message = string.Join(" ", args.Skip(index));
        if (message.Length == 0)
        {
            await source.Reply("Usage: " + usage);
            return;
        }
        request["message"] = message;
        var created = await manager.ExecuteTimerCommandAsync(owner, "create_timer", request);
        if (created["timer"] is not JsonObject timerRow)
        {
            await source.Reply(
                "❌ Timer creation failed: "
                    + (SessionWait.Text(created["error"]?["message"]) ?? "Timer unavailable.")
                    + (
                        SessionCatalog.Flag(created["timerCommitted"])
                            ? $" Timer `{created["timerId"]}` was committed."
                            : ""
                    )
            );
            return;
        }
        await source.Reply(
            $"✅ Timer created: `{timerRow["id"]}`\n"
                + (sub == "cron" ? "Next run: " : "Fires at: ")
                + Date(timerRow["nextRunAt"])
        );
    }
}
