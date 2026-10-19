using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task HandleSessionAdministrationAsync(
        ExternalChannelContext source,
        string[] args,
        SessionOwner? selected
    )
    {
        var manager = runtime.Manager;
        var sub = args.FirstOrDefault();
        var rest = args.Skip(1).ToArray();
        // Unlike /skill, Source's /session explicitly resolves its binding.
        var id =
            selected?.Id ?? SessionWait.Text(manager.ChannelBinding(source.Target)?["sessionId"]);
        var owner = selected;
        async Task<SessionOwner?> CurrentAsync()
        {
            owner ??= id is null ? null : await runtime.GetOwnerAsync(id);
            if (owner is null)
                await source.Reply("❌ No active session.");
            return owner;
        }
        void Bind(SessionOwner created)
        {
            manager.DetachChannel(source.Target);
            manager.AttachChannel(source.Target, created);
        }
        if (sub is null)
        {
            var tree = ExternalCommands.Find("/session")!["autocomplete"]!["children"]!.AsArray();
            await source.Reply(
                "📋 *Session Commands*\n\n"
                    + string.Join(
                        "\n",
                        tree.OfType<JsonObject>()
                            .Select(row =>
                                $"`{SessionWait.Text(row["usage"]) ?? "/session " + row["value"]}` - {row["description"]}"
                            )
                    )
            );
            return;
        }
        switch (sub)
        {
            case "list":
                var page = Math.Max(1, CommandArguments.Integer(rest.FirstOrDefault()) ?? 1);
                var (total, rows) = manager.CatalogMetadataOffset(
                    (int)Math.Min(int.MaxValue, (long)(page - 1) * 20),
                    20
                );
                var pages = Math.Max(1, (long)Math.Ceiling(total / 20d));
                if (total > 0 && page > pages)
                {
                    await source.Reply($"Page {page} not found. Total pages: {pages}");
                    return;
                }
                var output = $"📋 *All Sessions* (Page {page}/{pages})\n\n";
                var bindings = manager.ChannelBindings();
                foreach (var row in rows)
                {
                    var sid = SessionWait.Text(row["id"]);
                    output +=
                        $"`{sid}`"
                        + (
                            SessionWait.Text(row["displayName"]) is { } display
                                ? " (" + display + ")"
                                : ""
                        )
                        + $" - {row["messageCount"]} msgs - node: `{SessionWait.Text(row["currentNode"]) ?? "master"}`"
                        + (SessionCatalog.Flag(row["isolated"]) ? " isolated" : "")
                        + "\n";
                    var channels = bindings
                        .Where(pair =>
                            !pair.Key.StartsWith("webui:", StringComparison.Ordinal)
                            && SessionWait.Text(pair.Value?["sessionId"]) == sid
                        )
                        .Select(pair => pair.Key)
                        .ToArray();
                    if (channels.Length > 0)
                        output += "    - channels: `" + string.Join(", ", channels) + "`\n";
                }
                if (pages > 1)
                    output += "\nUse `/session list <page>` to view other pages.";
                await source.Reply(output);
                return;
            case "new":
                var fresh = await manager.CreateAsync();
                Bind(fresh);
                await source.Reply($"✅ Created and attached to new session `{fresh.Id}`");
                return;
            case "create":
                if (rest.Length < 2)
                {
                    await source.Reply(
                        "Usage: /session create <agent> <session> [--model <model>] [--effort <level>] [--system-prompt-file <path>]..."
                    );
                    return;
                }
                var flags = CommandArguments.SessionCreate(rest.Skip(2).ToArray());
                owner ??= id is null ? null : await runtime.GetOwnerAsync(id);
                var model = flags.Model is null
                    ? null
                    : CommandArguments.ResolveModel(flags.Model, manager.Models);
                var parentSettings = owner?.Entry.Snapshot().AuthorityEnvelope;
                var inheritedModel =
                    model
                    ?? SessionWait.Text(parentSettings?["childModelDefault"])
                    ?? SessionWait.Text(parentSettings?["model"]);
                var inheritedEffort =
                    flags.Effort
                    ?? SessionWait.Text(parentSettings?["childEffortDefault"])
                    ?? SessionWait.Text(parentSettings?["effort"]);
                var force = new JsonObject();
                if (model is not null)
                    force["modelId"] = model;
                if (flags.Effort is not null)
                    force["effort"] = flags.Effort;
                var created = await manager.CreateNamedAsync(
                    rest[0],
                    rest[1],
                    null,
                    force,
                    initialNode: owner is null ? null : manager.CurrentNode(owner),
                    inherited: (inheritedModel, inheritedEffort),
                    selectedFiles: flags.Files.Length == 0 ? null : flags.Files
                );
                Bind(created);
                var createdDto = created.BuildDto();
                await source.Reply(
                    $"✅ Created session `{created.Id}` under agent `{created.Agent}` and attached current channel.\nModel: `{createdDto["modelKey"]}`\nEffort: {created.Metadata().Effort ?? "unset/default"}"
                );
                return;
            case "refresh-snapshot":
                var refreshId = rest.FirstOrDefault() ?? id;
                if (refreshId is null)
                {
                    await source.Reply(
                        "❌ No active session. Usage: /session refresh-snapshot [session-id]"
                    );
                    return;
                }
                await runtime.RefreshSnapshotAsync(refreshId);
                var refreshed = await manager.RequiredAsync(refreshId);
                await source.Reply(
                    $"✅ Session `{refreshId}` snapshot refreshed.\nAgent: `{refreshed.Agent}`"
                );
                return;
            case "delete":
                owner ??= id is null ? null : await runtime.GetOwnerAsync(id);
                await ReplyRouteAsync(
                    source,
                    await HandleDeleteCommandAsync(
                        new(id ?? "", source.Type),
                        "/session " + string.Join(" ", args),
                        owner,
                        publishReply: false
                    )
                );
                return;
            case "parent" or "unparent" or "archive" or "unarchive":
                if ((sub == "parent" ? rest.Length < 2 : rest.Length == 0) && id is null)
                {
                    await source.Reply(
                        sub == "parent" && rest.Length == 0
                            ? "Usage: /session parent <parent-session-id> [child-session-id]"
                            : "❌ No active session. Specify the target session explicitly."
                    );
                    return;
                }
                await ReplyRouteAsync(
                    source,
                    HandlePresentationCommand(
                        new(id ?? "", source.Type),
                        "/session " + string.Join(" ", args),
                        publishReply: false
                    )
                );
                return;
        }
        owner = await CurrentAsync();
        if (owner is null)
            return;
        switch (sub)
        {
            case "child-model":
                await HandleModelCommandAsync(source, rest, owner, child: true);
                return;
            case "fork":
                var child = await runtime.ForkAsync(
                    owner.Id,
                    rest.FirstOrDefault()
                );
                Bind(child);
                await source.Reply(
                    $"✅ Forked child session `{owner.Id}` → `{child.Id}`\nMessages: {owner.Metadata().MessageCount}"
                );
                return;
            case "clear":
                var cleared = await runtime.ClearHistoryAsync(owner.Id);
                await source.Reply(
                    cleared.RequiresRetry
                        ? "🛑 Current session is busy. Stop signal sent."
                            + (
                                cleared.AbortedInFlight
                                    ? " The in-flight LLM request was aborted."
                                    : " It will stop after the current tool call completes."
                            )
                            + (
                                cleared.DroppedQueueItems > 0
                                    ? $" Cleared {cleared.DroppedQueueItems} queued item(s)."
                                    : ""
                            )
                            + " Retry /session clear after it becomes idle."
                        : "Session cleared."
                );
                return;
            case "rename":
                if (rest.Length == 0)
                {
                    await source.Reply(
                        "Usage: /session rename <new name>\nExample: /session rename My Project\nUse /session rename - to clear the name."
                    );
                    return;
                }
                var name = string.Join(" ", rest);
                await runtime.UpdateDisplayNameAsync(owner.Id, name == "-" ? null : name.Trim());
                await source.Reply(
                    name == "-"
                        ? "✅ Session display name cleared."
                        : $"✅ Session renamed to \"{name.Trim()}\"."
                );
                return;
            case "compact-threshold":
                if (rest.Length > 0)
                {
                    var value = rest[0].Trim().ToLowerInvariant();
                    double? threshold = null;
                    if (value is not ("clear" or "unset"))
                    {
                        var match = Regex.Match(value, @"^(\d+(?:\.\d+)?)(k)?$");
                        if (!match.Success)
                            throw new InvalidDataException(
                                "Compact threshold must be a positive integer token count or use the `k` suffix, e.g. `8000` or `8k`."
                            );
                        threshold =
                            double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture)
                            * (match.Groups[2].Success ? 1000 : 1);
                        if (!double.IsFinite(threshold.Value) || threshold <= 0)
                            throw new InvalidDataException(
                                "Compact threshold must be greater than 0."
                            );
                        threshold = Math.Floor(threshold.Value);
                    }
                    await owner.Entry.SaveLane.CommitSettingsAsync(
                        new JsonObject { ["compactThresholdTokens"] = threshold },
                        manager.Models
                    );
                }
                var dto = owner.BuildDto();
                await source.Reply(
                    $"🧮 Compact threshold override: {(dto["compactThresholdTokens"] is null ? "inherit global default" : "`" + dto["compactThresholdTokens"] + "` tokens")}\nEffective auto-compact threshold: `{dto["effectiveCompactThresholdTokens"]}` tokens"
                );
                return;
            case "isolated":
                var bound = manager.BoundNode(owner.Agent);
                await source.Reply(
                    bound is null
                        ? "ℹ️ Session-level isolated mode has been removed. Use `currentNode` for ordinary node selection, or `/agent isolated <agent> <node-id|off>` for agent-level isolation."
                        : $"🔒 Session-level isolated mode has been removed. This session inherits agent isolation on node `{bound}`. Use `/agent isolated` to change it."
                );
                return;
            case "index":
                await source.Reply("🔄 Indexing session archive...");
                try
                {
                    var latest = await manager.ForceVectorIndexAsync(owner);
                    await source.Reply($"✅ Archive indexing completed up to seq {latest}.");
                }
                catch (Exception error)
                {
                    await source.Reply("❌ Indexing failed: " + error.Message);
                }
                return;
            case "move":
                await ReplyRouteAsync(
                    source,
                    await HandleIdentityMoveCommandAsync(
                        new(owner.Id, source.Type),
                        "/session " + string.Join(" ", args),
                        owner,
                        publishReply: false
                    )
                );
                return;
            default:
                await source.Reply(
                    $"❌ Unknown subcommand: {sub}\nUse `/session` to see available commands."
                );
                return;
        }
    }
}
