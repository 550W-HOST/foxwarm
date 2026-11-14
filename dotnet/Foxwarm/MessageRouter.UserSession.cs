using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm;

// `/session` commands.
internal sealed partial class MessageRouter
{
    private async Task SessionStatusAsync(UserCommand command)
    {
        var target = await command.TargetAsync();
        await command.Reply(
            SessionWait.Text(
                (
                    await runtime.Manager.ObserveAsync(
                        target,
                        "session",
                        new JsonObject { ["action"] = "status" },
                        administrator: true
                    )
                )["output"]
            )!
        );
    }

    private async Task SessionListAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var start = (int)Math.Clamp(Math.Truncate(command.Call.Number("start") ?? 0), 0, int.MaxValue);
        var count = (int)Math.Clamp(Math.Truncate(command.Call.Number("count") ?? 20), 1, 200);
        var scope = command.Text("scope") ?? "all";
        string? agent = null;
        if (scope == "current-agent")
            agent =
                (await command.CurrentAsync())?.Agent
                ?? throw new UserCommandException("❌ No active session; use --scope all.");
        var query = command.Text("query");
        var (total, rows) = manager.AdministratorSessionList(query, start, count, agent);
        var matching = query is null ? "" : $" matching `{query}`";
        if (total == 0)
        {
            await command.Reply($"No sessions found{matching}.");
            return;
        }
        if (rows.Length == 0)
        {
            await command.Reply($"No sessions in the requested range. Total sessions{matching}: {total}.");
            return;
        }
        var output =
            $"📋 *Sessions*{matching} ({start + 1}-{start + rows.Length} of {total})\n\n";
        var bindings = manager.ChannelBindings();
        foreach (var row in rows)
        {
            var sid = SessionWait.Text(row["id"]);
            output +=
                $"`{sid}`"
                + (SessionWait.Text(row["displayName"]) is { } display ? " (" + display + ")" : "")
                + $" - {row["messageCount"]} msgs - node: `{SessionWait.Text(row["currentNode"]) ?? "master"}`"
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
        if (start + rows.Length < total)
            output += $"\nUse `/session list --start {start + rows.Length}` for the next page.";
        await command.Reply(output);
    }

    private async Task SessionRenameAsync(UserCommand command)
    {
        var id = command.TargetId();
        var name = command.Text("name")!.Trim();
        await runtime.UpdateDisplayNameAsync(id, name.Length == 0 ? null : name);
        await command.Reply(
            name.Length == 0
                ? $"✅ Session `{id}` display name cleared."
                : $"✅ Session `{id}` renamed to \"{name}\"."
        );
    }

    private async Task SessionPresentationAsync(UserCommand command)
    {
        var id = command.Text("sessionId");
        if (id is null && command.CurrentId is null)
            throw new UserCommandException("❌ No active session. Specify the target session explicitly.");
        await ReplyRouteAsync(
            command.Source,
            HandlePresentationCommand(
                new(command.CurrentId ?? "", command.Source.Type),
                command.Verb,
                id,
                command.Text("parentSessionId"),
                publishReply: false
            )
        );
    }

    private async Task SessionCreateAsync(UserCommand command)
    {
        var manager = runtime.Manager;
        var current = await command.CurrentAsync();
        var model = command.Text("model") is { } requested
            ? CommandArguments.ResolveModel(requested, manager.Models)
            : null;
        var effort = EffortValue(command.Text("effort"));
        var parentSettings = current?.Entry.Snapshot().AuthorityEnvelope;
        var inheritedModel =
            model
            ?? SessionWait.Text(parentSettings?["childModelDefault"])
            ?? SessionWait.Text(parentSettings?["model"]);
        var inheritedEffort =
            effort
            ?? SessionWait.Text(parentSettings?["childEffortDefault"])
            ?? SessionWait.Text(parentSettings?["effort"]);
        var force = new JsonObject();
        if (model is not null)
            force["modelId"] = model;
        if (effort is not null)
            force["effort"] = effort;
        var files = SessionWait.Strings(command.Call.Args["systemPromptFiles"]).ToArray();
        var created = await manager.CreateNamedAsync(
            command.Text("agentName")!,
            command.Text("sessionName")!,
            command.Text("displayName"),
            force,
            inherited: (inheritedModel, inheritedEffort),
            selectedFiles: files.Length == 0 ? null : files,
            parentSessionId: command.Text("parentSessionId"),
            initialNode: command.Text("node")
        );
        command.Attach(created);
        var createdDto = created.BuildDto();
        await command.Reply(
            $"✅ Created session `{created.Id}` under agent `{created.Agent}` and attached current channel.\nModel: `{createdDto["modelKey"]}`\nEffort: {created.Metadata().Effort ?? "unset/default"}"
        );
    }

    private async Task SessionNewAsync(UserCommand command)
    {
        var fresh = await runtime.Manager.CreateAsync();
        command.Attach(fresh);
        await command.Reply($"✅ Created and attached to new session `{fresh.Id}`");
    }

    private async Task SessionMoveAsync(UserCommand command)
    {
        var caller = await command.TargetAsync();
        var args = (JsonObject)command.Call.Args.DeepClone();
        args["sessionId"] = caller.Id;
        await ReplyRouteAsync(
            command.Source,
            await HandleIdentityMoveCommandAsync(
                new(caller.Id, command.Source.Type),
                args,
                caller,
                publishReply: false
            )
        );
    }

    private async Task SessionDeleteAsync(UserCommand command) =>
        await ReplyRouteAsync(
            command.Source,
            await HandleDeleteCommandAsync(
                new(command.CurrentId ?? "", command.Source.Type),
                command.Text("sessionId")!,
                await command.CurrentAsync(),
                publishReply: false
            )
        );

    private async Task SessionClearAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var cleared = await runtime.ClearHistoryAsync(owner.Id);
        await command.Reply(
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
    }

    private async Task SessionStopAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        if (command.Flag("compaction"))
        {
            var cancelled = await owner.Compactor.StopAsync();
            await command.Reply(
                cancelled.TooLate ? "⚠️ Compaction had already committed; cancellation was too late."
                : cancelled.Cancelled ? "🛑 Compaction cancelled. The current Session run was not stopped."
                : "⚠️ No active compaction to cancel."
            );
            return;
        }
        if (!owner.Metadata().Busy)
        {
            await command.Reply("⚠️ Session is not currently running.");
            return;
        }
        if (owner.Compactor.Standalone)
        {
            await command.Reply(
                "⚠️ No main Session run was stopped. Compaction continues; use `/stop --compaction` to cancel it."
            );
            return;
        }
        var queued = owner.Metadata().QueueLength > 0;
        var stopped = await owner.Registry.Control.StopAsync(owner.Id);
        await command.Reply(
            (
                stopped.AbortedInFlight
                    ? "🛑 Stop signal sent. The in-flight LLM request was aborted."
                    : "🛑 Stop signal sent. The session will stop after the current tool call completes."
            ) + (queued ? " Queued inputs will be added to history without being run." : "")
        );
    }

    private async Task SessionContinueAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        if (owner.Metadata().Busy || owner.Processing)
        {
            await command.Reply("⚠️ Session is already running.");
            return;
        }
        if (owner.WaitSnapshot() is not null)
        {
            await command.Reply("⚠️ Session is waiting and cannot be continued manually.");
            return;
        }
        await command.Reply("▶️ Continuing interrupted turn...");
        var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var running = owner.StartProcessing(retry: true, admitted: () => admitted.TrySetResult());
        await Task.WhenAny(admitted.Task, running);
        if (!admitted.Task.IsCompleted)
        {
            try
            {
                await running;
            }
            catch (SessionContinuationUnavailableException error)
            {
                await command.Reply("⚠️ " + error.Message);
            }
        }
        else
            _ = ObserveControlSettlementAsync(running);
    }

    private async Task SessionDequeueAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var dequeue = await runtime.DequeueAsync(owner.Id);
        await command.Reply(
            dequeue.QueuedItems == 0
                ? "⚠️ No queued items to run."
                : $"▶️ Running {dequeue.QueuedItems} queued item{(dequeue.QueuedItems > 1 ? "s" : "")}."
                    + (
                        dequeue.StoppedCurrent
                            ? dequeue.AbortedInFlight
                                ? " The in-flight LLM request was aborted first."
                                : " After the current tool call stops."
                            : ""
                    )
        );
    }

    private async Task SessionBtwAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var question = command.Text("message")!.Trim();
        if (question.Length == 0)
            throw new UserCommandException("Usage: /btw <message>");
        runtime.Manager.StartBtw(owner, question);
        await command.Reply("📝 BTW request started. I’ll post the result here when it finishes.");
    }

    private async Task SessionModelAsync(UserCommand command, bool child)
    {
        var owner = await command.TargetAsync();
        var patch = new JsonObject();
        if (command.Has("effort"))
            patch[child ? "childEffortDefault" : "effort"] = EffortValue(command.Text("effort"));
        if (child && command.Flag("clear"))
        {
            if (command.Has("model"))
                throw new UserCommandException("❌ Give either a model or --clear.");
            patch["childModelDefault"] = null;
        }
        if (command.Text("model") is { } target)
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
        if (!child && patch.Count == 0)
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
                    $"- `{option.Key}`" + (tags.Length == 0 ? "" : " (" + string.Join(", ", tags) + ")")
                );
            }
        }
        await command.Reply(string.Join("\n", lines));
    }

    private async Task SessionForkAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        // An omitted name is `fork`, numbered on collision; an explicit name must be free.
        var suffix = command.Text("suffix") ?? "fork";
        var message = command.Text("message") is { Length: > 0 } text ? text : null;
        try
        {
            var requested =
                owner.Id.Split('/').Last() == "main"
                    ? SessionIdentity.Build(owner.Agent, suffix)
                    : owner.Id + "_" + suffix;
            if (command.Has("suffix") && runtime.Catalog.Get(requested) is not null)
                throw new UserCommandException($"❌ Session `{requested}` already exists.");
            var child = await runtime.ForkCommandAsync(owner.Id, suffix, message);
            if (command.Flag("attach"))
                command.Attach(child);
            await command.Reply(
                $"✅ Forked session `{owner.Id}` → `{child.Id}`"
                    + (message is null ? "" : "\nInitial message sent.")
                    + (command.Flag("attach") ? "\nThis conversation is now attached to the fork." : "")
            );
        }
        catch (UserCommandException)
        {
            throw;
        }
        catch (Exception error)
        {
            throw new UserCommandException("❌ Fork failed: " + error.Message);
        }
    }

    private async Task SessionMessagesAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var history = owner.History();
        var total = history.Count;
        var first = (int)command.Call.Number("count")!.Value;
        int? second = command.Call.Number("end") is { } end ? (int)end : null;
        if (second is null && first == 0)
            throw new UserCommandException("Usage: `/session messages <count>` | `/session messages <start> <end>`");
        var start =
            second is null
                ? first > 0
                    ? 0
                    : Math.Max(0, total + first)
                : Math.Clamp(first < 0 ? total + first : first, 0, total);
        var stop =
            second is null
                ? first > 0
                    ? Math.Min(first, total)
                    : total
                : Math.Clamp(second.Value < 0 ? total + second.Value : second.Value, 0, total);
        if (stop < start)
        {
            await command.Reply("No messages found in the specified range.");
            return;
        }
        var selected = history.Skip(start).Take(stop - start).ToArray();
        if (selected.Length == 0)
        {
            await command.Reply($"No messages found in session `{owner.Id}` (total: {total} messages).");
            return;
        }
        await command.Reply(ContextPreviewRenderer.CommandMessages(owner.Id, total, start, selected));
    }

    private async Task SessionDeleteMessagesAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var count = (int)Math.Clamp(command.Call.Number("count")!.Value, int.MinValue, int.MaxValue);
        if (count == 0)
            throw new UserCommandException(
                "Usage: `/session delete-messages <count>` (positive: delete oldest, negative: delete newest)"
            );
        var deleted = await owner.Entry.SaveLane.DeleteMessagesAsync(count);
        await command.Reply($"✅ Deleted {deleted.Deleted} messages. Remaining: {deleted.Remaining}.");
    }

    private async Task SessionVerboseAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        if (command.Text("state") is not { } value)
        {
            var verbose = owner.Entry.WithState(state =>
                SessionCatalog.Flag(state.AuthorityEnvelope["verbose"])
            );
            await command.Reply($"Verbose mode is currently *{(verbose ? "on" : "off")}*.");
            return;
        }
        await owner.Entry.SaveLane.CommitSettingsAsync(
            new JsonObject { ["verbose"] = value == "on" },
            runtime.Manager.Models
        );
        await command.Reply(
            value == "on"
                ? "✅ Verbose mode enabled. Tool calls will be shown."
                : "✅ Verbose mode disabled. Tool calls will be hidden."
        );
    }

    private async Task SessionIndexAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        await command.Reply("🔄 Indexing session archive...");
        try
        {
            var latest = await runtime.Manager.ForceVectorIndexAsync(owner);
            await command.Reply($"✅ Archive indexing completed up to seq {latest}.");
        }
        catch (Exception error)
        {
            await command.Reply("❌ Indexing failed: " + error.Message);
        }
    }

    private async Task SessionRefreshAsync(UserCommand command)
    {
        var id = command.TargetId();
        try
        {
            await runtime.RefreshSnapshotAsync(id);
            var refreshed = await runtime.Manager.RequiredAsync(id);
            await command.Reply($"✅ Session `{id}` snapshot refreshed.\nAgent: `{refreshed.Agent}`");
        }
        catch (Exception error)
        {
            throw new UserCommandException("❌ Snapshot refresh failed: " + error.Message);
        }
    }

    private async Task SessionCompactThresholdAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        if (command.Text("value") is { } raw)
        {
            var value = raw.Trim().ToLowerInvariant();
            double? threshold = null;
            if (value is not ("clear" or "unset"))
            {
                var match = Regex.Match(value, @"^(\d+(?:\.\d+)?)(k)?$");
                if (!match.Success)
                    throw new UserCommandException(
                        "❌ Compact threshold must be a positive integer token count or use the `k` suffix, e.g. `8000` or `8k`."
                    );
                threshold =
                    double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture)
                    * (match.Groups[2].Success ? 1000 : 1);
                if (!double.IsFinite(threshold.Value) || threshold <= 0)
                    throw new UserCommandException("❌ Compact threshold must be greater than 0.");
                threshold = Math.Floor(threshold.Value);
            }
            await owner.Entry.SaveLane.CommitSettingsAsync(
                new JsonObject { ["compactThresholdTokens"] = threshold },
                runtime.Manager.Models
            );
        }
        var dto = owner.BuildDto();
        await command.Reply(
            $"🧮 Compact threshold override: {(dto["compactThresholdTokens"] is null ? "inherit global default" : "`" + dto["compactThresholdTokens"] + "` tokens")}\nEffective auto-compact threshold: `{dto["effectiveCompactThresholdTokens"]}` tokens"
        );
    }

    private async Task SessionCompactAsync(UserCommand command)
    {
        var owner = await command.TargetAsync();
        var keep = KeepPercent(command);
        if (owner.Entry.HistoryMutation)
            throw new InvalidOperationException("Session history change is in progress.");
        if (owner.Entry.WithState(state => state.History.Count == 0))
        {
            await command.Reply("History is empty.");
            return;
        }
        if (command.Flag("tools"))
        {
            var pruned = await owner.Compactor.PruneToolsManuallyAsync(keep);
            await command.Reply(pruned.Text);
            return;
        }
        var compact = await owner.Compactor.StartManualAsync(keepPercent: keep);
        await command.Reply(
            compact.AlreadyPending ? "ℹ️ Compaction is already pending for this session."
            : compact.Started
                ? compact.Background
                        ? "🗜️ Compaction requested. It runs in parallel, so this chat can continue normally."
                    : "🗜️ Compaction started. This session will remain busy until awaited compaction finishes."
            : "⚠️ This model disables background compaction. Stop or wait for the current run to finish, then request compaction again."
        );
    }
}
