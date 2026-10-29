using System.Text.Json.Nodes;
using Foxwarm.Timers;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private readonly MainTimers timers;
    internal MainTimers Timers => timers;
    internal Func<string, string>? TimerSessionName { get; set; }

    private static string TimerOwner(SessionOwner source, JsonObject args) =>
        ToolRegistry.Text(args, "sessionId") is { Length: > 0 } requested ? requested : source.Id;

    private void CheckTimerIsolation(SessionOwner source, JsonObject args, string requested)
    {
        if (!AgentIsolated(source.Agent))
            return;
        if (requested != source.Id)
            throw new ToolAuthorizationDeniedException(
                "Isolated session can only manage timers for its own current session."
            );
        var agent = TimerArguments.Optional(args["agentName"]);
        var prefix = TimerArguments.Optional(args["sessionPrefix"]);
        if (MainTimers.Flag(args["newSession"]))
        {
            if (agent is not null && agent != source.Agent)
                throw new ToolAuthorizationDeniedException(
                    "Isolated session timers may only create sessions in their own Agent."
                );
        }
        else if (agent is not null || prefix is not null)
            throw new ToolAuthorizationDeniedException(
                "Isolated timers may only specify new-session target settings together with newSession=true."
            );
    }

    internal Task<JsonObject> ExecuteTimerToolAsync(
        SessionOwner source,
        string name,
        JsonObject args,
        CancellationToken token
    ) => ExecuteTimerAsync(source, name, args, token, authorizeTool: true);

    internal Task<JsonObject> ExecuteTimerCommandAsync(
        SessionOwner source,
        string name,
        JsonObject args
    ) => ExecuteTimerAsync(source, name, args, CancellationToken.None, authorizeTool: false);

    private async Task<JsonObject> ExecuteTimerAsync(
        SessionOwner source,
        string name,
        JsonObject args,
        CancellationToken token,
        bool authorizeTool
    )
    {
        var allowed = name switch
        {
            "create_timer" => new[]
            {
                "sessionId",
                "at",
                "afterSeconds",
                "cron",
                "message",
                "action",
                "script",
                "newSession",
                "sessionPrefix",
                "agentName",
            },
            "update_timer" =>
            [
                "timerId",
                "sessionId",
                "at",
                "afterSeconds",
                "cron",
                "message",
                "action",
                "script",
                "newSession",
                "sessionPrefix",
                "agentName",
            ],
            "delete_timer" => ["timerId", "sessionId"],
            _ => ["sessionId"],
        };
        ToolRegistry.Keys(args, allowed);
        var requested = TimerOwner(source, args);
        CheckTimerIsolation(source, args, requested);
        using var admitted = BeginOwnerMutation(source);
        async Task PrepareAsync()
        {
            while (true)
            {
                await WaitForIdentityMutationAsync(source.Id, token);
                var id = source.Id;
                var agent = source.Agent;
                CheckTimerIsolation(source, args, requested);
                if (authorizeTool)
                    await AuthorizeToolAsync(source, new(name, "builtin", name, args), null, token);
                if (source.Id == id && source.Agent == agent)
                    return;
            }
        }
        try
        {
            if (name == "list_timers")
            {
                var list = timers.List(requested);
                return new JsonObject
                {
                    ["output"] =
                        list.Count == 0
                            ? "No timers found for session '" + requested + "'."
                            : "Found " + list.Count + " timer(s):\n" + list.ToJsonString(),
                    ["timers"] = list,
                };
            }
            var id = name == "create_timer" ? null : ToolRegistry.Text(args, "timerId");
            if (id is not null && name == "update_timer")
                id = SessionGoal.Trim(id);
            if (name != "create_timer" && string.IsNullOrEmpty(id))
                throw new InvalidDataException("timerId is required.");
            if (name == "delete_timer")
            {
                token.ThrowIfCancellationRequested();
                var deleted = await timers.DeleteAsync(id!, requested, token, PrepareAsync);
                return new JsonObject
                {
                    ["output"] = "Timer '" + id + (deleted ? "' deleted." : "' not found."),
                    ["deleted"] = deleted,
                };
            }
            var existing = name == "update_timer" ? timers.Get(id!, requested) : null;
            var owner = await RequiredAsync(
                existing is null ? requested : SessionWait.Text(existing["sessionId"])!,
                token
            );
            await WaitForIdentityMutationAsync(source.Id, token);
            CheckTimerIsolation(source, args, requested);
            if (authorizeTool)
                await AuthorizeToolAsync(source, new(name, "builtin", name, args), null, token);
            if (
                (
                    TimerArguments.Script(args)
                    || existing is not null && TimerArguments.Script(existing)
                ) && (owner.Id != source.Id || existing is not null && requested != source.Id)
            )
                throw new InvalidDataException(
                    "Only the owner Session may configure a ToolScript timer."
                );
            var target = TimerSnapshot(owner);
            var row = existing is null
                ? MainTimers.CreateRow(
                    TimerArguments.Script(args) ? owner.Id : requested,
                    args,
                    target
                )
                : MainTimers.UpdateRow(existing, args, target);
            if (MainTimers.Flag(row["newSession"]))
            {
                if (authorizeTool)
                    agents.RequireSessionTarget(source.Agent, SessionWait.Text(row["agentName"])!);
                var agent = SessionWait.Text(row["agentName"])!;
                if (!agents.Exists(agent) || !Directory.Exists(agents.AgentDirectory(agent)))
                    throw new InvalidDataException("Timer target Agent does not exist: " + agent);
                NormalizeTimerSettings(row);
            }
            token.ThrowIfCancellationRequested();
            source.Entry.RequireIdentityAuthority();
            var timer = existing is null
                ? await timers.CreateAsync(
                    row,
                    token,
                    async () =>
                    {
                        await PrepareAsync();
                        if (authorizeTool && MainTimers.Flag(row["newSession"]))
                            agents.RequireSessionTarget(source.Agent, SessionWait.Text(row["agentName"])!);
                        if (
                            AgentIsolated(source.Agent)
                            && MainTimers.Flag(row["newSession"])
                            && SessionWait.Text(row["agentName"]) != source.Agent
                        )
                            throw new ToolAuthorizationDeniedException(
                                "Isolated timer target Agent is no longer the caller's Agent."
                            );
                    }
                )
                : await timers.UpdateAsync(
                    id!,
                    row,
                    token,
                    async () =>
                    {
                        await PrepareAsync();
                        if (authorizeTool && MainTimers.Flag(row["newSession"]))
                            agents.RequireSessionTarget(source.Agent, SessionWait.Text(row["agentName"])!);
                        if (
                            AgentIsolated(source.Agent)
                            && MainTimers.Flag(row["newSession"])
                            && SessionWait.Text(row["agentName"]) != source.Agent
                        )
                            throw new ToolAuthorizationDeniedException(
                                "Isolated timer target Agent is no longer the caller's Agent."
                            );
                    }
                );
            return new JsonObject
            {
                ["output"] =
                    "Timer '"
                    + SessionWait.Text(timer["id"])
                    + (existing is null ? "' created." : "' updated.")
                    + "\n"
                    + timer.ToJsonString(),
                ["timer"] = timer,
            };
        }
        catch (TimerCommittedException error)
        {
            var result = UnsupportedTurnToolExecutor.ToolError(
                "timer_committed_partial",
                error.Message
            );
            result["timerCommitted"] = true;
            result["timerId"] = error.TimerId;
            return result;
        }
    }

    private JsonObject TimerSnapshot(SessionOwner owner) =>
        owner.Entry.WithState(state =>
        {
            var result = new JsonObject { ["agent"] = owner.Agent };
            foreach (var key in new[] { "currentNode", "model", "effort" })
                if (state.AuthorityEnvelope[key] is not null)
                    result[key] = state.AuthorityEnvelope[key]!.DeepClone();
            return result;
        });

    private void NormalizeTimerSettings(JsonObject row)
    {
        var model = TimerArguments.Optional(row["model"]);
        var effort = SessionWait.Text(row["effort"]);
        var catalog = models.Capture();
        var leaf = catalog.Resolve(model);
        if (model is null)
            row.Remove("model");
        else
            row["model"] = model;
        if (effort is not null && leaf.AllowedEfforts.Contains(effort, StringComparer.Ordinal))
            row["effort"] = effort;
        else
            row.Remove("effort");
    }

    private async Task DeliverTimerAsync(JsonObject timer)
    {
        if (TimerArguments.Script(timer))
        {
            var owner =
                await GetExistingAsync(SessionWait.Text(timer["sessionId"])!, acceptedTimer: true)
                ?? throw new InvalidDataException("Timer owner Session not found.");
            using (BeginOwnerMutation(owner, acceptedTimer: true))
            {
                await WaitForIdentityMutationAsync(owner.Id);
                owner.Entry.RequireIdentityAuthority();
                if (!IsCurrentOwner(owner))
                    throw new InvalidOperationException("Timer owner lifetime is unavailable.");
            }
            // Admission fences the exact owner, not the script's nested mutations. The scheduler
            // drains the accepted slice; retaining this lease would block surviving-child deletion.
            // A separate dispatcher has no foreground batch, wait control or abort slot.
            var dispatcher = new SessionToolExecutor(
                new WorkspaceTools(
                    agents.AgentDirectory(owner.Agent),
                    pendingWrites,
                    owner.Id,
                    owner.Agent
                ),
                owner,
                this,
                tools,
                unattended: true
            );
            var outcome = await dispatcher.ExecuteAsync(
                new JsonObject { ["name"] = "run_script", ["args"] = timer["script"]!.DeepClone() },
                CancellationToken.None
            );
            if (outcome is JsonObject result && result["error"] is not null)
                Console.Error.WriteLine(
                    "Timer ToolScript failed: "
                        + SessionWait.Text(timer["id"])
                        + " "
                        + result.ToJsonString()
                );
            return;
        }
        SessionOwner target;
        if (MainTimers.Flag(timer["newSession"]))
            target = await CreateTimerSessionAsync(timer);
        else
            target = await RequiredAsync(SessionWait.Text(timer["sessionId"])!);
        using var admission = BeginOwnerMutation(target);
        await WaitForIdentityMutationAsync(target.Id);
        target.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(target))
            throw new InvalidOperationException("Timer target lifetime is unavailable.");
        await target.Registry.Ingress.EnqueueTimerAsync(
            target.Id,
            new QueueItem(
                QueueItemType.Background,
                [new JsonObject { ["system"] = MainTimers.TriggeredMessage(timer) }]
            )
        );
    }

    private async Task<SessionOwner> CreateTimerSessionAsync(JsonObject timer)
    {
        var owner = AuthorizationTarget(SessionWait.Text(timer["sessionId"])!);
        var agent = TimerArguments.Optional(timer["agentName"]) ?? owner?.Agent ?? "main";
        if (!agents.Exists(agent) || !Directory.Exists(agents.AgentDirectory(agent)))
            throw new InvalidDataException("Timer target Agent does not exist.");
        var settings = (JsonObject)timer.DeepClone();
        NormalizeTimerSettings(settings);
        var inherited = (SessionWait.Text(settings["model"]), SessionWait.Text(settings["effort"]));
        var node = TimerArguments.Optional(timer["currentNode"]);
        var prefix = TimerArguments.Prefix(timer["sessionPrefix"]);
        using var creation = TrackCreation();
        while (true)
        {
            var name =
                TimerSessionName?.Invoke(prefix)
                ?? prefix
                    + "_"
                    + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    + "_"
                    + Convert.ToHexStringLower(
                        System.Security.Cryptography.RandomNumberGenerator.GetBytes(2)
                    );
            var id = SessionIdentity.Build(agent, name);
            var key = CreationKey(id);
            await key.WaitAsync();
            try
            {
                if (await IdReservedAsync(id))
                    continue;
                return await CreateNamedLockedAsync(
                    agent,
                    name,
                    null,
                    null,
                    inherited,
                    null,
                    timerCreation: true,
                    timerNode: node
                );
            }
            finally
            {
                key.Release();
            }
        }
    }

    private async Task ReconcileTimerWaitsAsync(SessionOwner owner)
    {
        if (!IsCurrentOwner(owner))
            return;
        var waitId = owner.Entry.WithState(state => SessionWait.Text(state.Meta["wait"]?["id"]));
        foreach (var requested in timers.InternalOwners())
            if (ReferenceEquals(Find(requested), owner))
                await timers.ConsumeValidatedWaitAsync(requested, waitId);
    }
}
