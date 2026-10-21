using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Timers;

internal sealed partial class MainTimers
{
    internal JsonObject Get(string id, string owner, bool allowInternal = false)
    {
        RequireAvailable();
        JsonObject captured;
        lock (gate)
        {
            if (!records.TryGetValue(id, out var record) || record.Internal && !allowInternal)
                throw new InvalidDataException("Timer '" + id + "' not found.");
            if (record.Ambiguous)
                throw new InvalidDataException("Timer ID is ambiguous: " + id);
            if (Text(record.Row["sessionId"]) != owner)
                throw new InvalidDataException("Timer does not belong to Session '" + owner + "'.");
            captured = record.Row;
        }
        return (JsonObject)captured.DeepClone();
    }

    internal JsonArray List(string owner)
    {
        RequireAvailable();
        TimerRecord[] items;
        lock (gate)
            items = records
                .Values.Where(record =>
                    !record.Internal
                    && !record.Ambiguous
                    && record.Ordinary
                    && Text(record.Row["sessionId"]) == owner
                )
                .ToArray();
        return new JsonArray(
            items
                .Select(record => View(record.Row))
                .OrderBy(row => Number(row["nextRunAt"]) ?? 9_007_199_254_740_991)
                .ThenBy(row => Number(row["createdAt"]) ?? 0)
                .Select(row => (JsonNode?)row)
                .ToArray()
        );
    }

    private JsonObject View(JsonObject row)
    {
        var view = (JsonObject)row.DeepClone();
        var cron =
            Text(row["cron"]) is string expression && SessionGoal.Trim(expression).Length > 0;
        JsonNode? next = null;
        lock (gate)
        {
            if (records.TryGetValue(Text(row["id"])!, out var current) && current.Reason is null)
            {
                if (cron)
                    next = current.Next is long stamp ? JsonValue.Create(stamp) : null;
                else if (
                    Number(row["at"]) is double at
                    && at > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                )
                    next = JsonValue.Create(at);
            }
        }
        view["mode"] = cron ? "cron" : "once";
        view["nextRunAt"] = next;
        return view;
    }

    internal async Task<JsonObject> CreateAsync(
        JsonObject row,
        CancellationToken token,
        Func<Task>? prepare = null
    )
    {
        var saved = await ChangeAsync(
            null,
            null,
            candidate =>
            {
                var rows = candidate["timers"]!.AsArray();
                string id;
                do
                {
                    id = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4));
                } while (rows.OfType<JsonObject>().Any(item => Text(item["id"]) == id));
                row = (JsonObject)row.DeepClone();
                row["id"] = id;
                rows.Add(row);
                return row;
            },
            token,
            prepare: prepare
        );
        return View(saved!.AsObject());
    }

    internal async Task<JsonObject> UpdateAsync(
        string id,
        JsonObject updated,
        CancellationToken token,
        Func<Task>? prepare = null
    )
    {
        var saved = await ChangeAsync(
            id,
            null,
            candidate =>
            {
                var rows = candidate["timers"]!.AsArray();
                var index = -1;
                for (var position = 0; position < rows.Count; position++)
                    if (rows[position] is JsonObject item && Text(item["id"]) == id)
                    {
                        if (index >= 0)
                            throw new InvalidDataException("Timer ID is ambiguous.");
                        index = position;
                    }
                if (index < 0)
                    rows.Add(updated.DeepClone());
                else
                    rows[index] = updated.DeepClone();
                return updated;
            },
            token,
            prepare: prepare,
            forceReplacement: true
        );
        return View(saved!.AsObject());
    }

    internal async Task<bool> DeleteAsync(
        string id,
        string owner,
        CancellationToken token,
        Func<Task>? prepare = null
    )
    {
        var result = await ChangeAsync(
            id,
            null,
            candidate =>
            {
                TimerRecord? record;
                lock (gate)
                    records.TryGetValue(id, out record);
                if (record is null)
                    return JsonValue.Create(false);
                if (record.Ambiguous)
                    throw new InvalidDataException("Timer ID is ambiguous.");
                if (Text(record.Row["sessionId"]) != owner)
                    throw new InvalidDataException("Timer does not belong to this Session.");
                var rows = candidate["timers"]!.AsArray();
                for (var index = rows.Count - 1; index >= 0; index--)
                    if (rows[index] is JsonObject row && Text(row["id"]) == id)
                        rows.RemoveAt(index);
                return JsonValue.Create(true);
            },
            token,
            prepare: prepare
        );
        return result!.GetValue<bool>();
    }

    internal static JsonObject CreateRow(string owner, JsonObject args, JsonObject target)
    {
        var schedule = TimerArguments.Normalize(args, required: true);
        var fresh = Flag(args["newSession"]);
        var prefix = args.ContainsKey("sessionPrefix")
            ? TimerArguments.Prefix(args["sessionPrefix"])
            : "timer";
        var row = new JsonObject
        {
            ["sessionId"] = owner,
            ["createdAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["newSession"] = fresh,
        };
        TimerArguments.PutAction(row, args);
        PutSchedule(row, schedule);
        if (fresh)
        {
            row["sessionPrefix"] = prefix;
            row["agentName"] =
                TimerArguments.Optional(args["agentName"]) ?? Text(target["agent"]) ?? "main";
            foreach (var key in new[] { "currentNode", "model", "effort" })
                if (target[key] is not null)
                    row[key] = target[key]!.DeepClone();
        }
        return row;
    }

    internal static JsonObject UpdateRow(JsonObject existing, JsonObject args, JsonObject owner)
    {
        var schedule = TimerArguments.Normalize(args, required: false);
        var message = args.ContainsKey("message");
        var newSession = args["newSession"] is not null;
        var changedTarget =
            TimerArguments.Optional(args["sessionPrefix"]) is not null
            || TimerArguments.Optional(args["agentName"]) is not null;
        if (
            !schedule.Provided
            && !message
            && !newSession
            && !changedTarget
            && !args.ContainsKey("action")
            && !args.ContainsKey("script")
        )
            throw new InvalidDataException("At least one timer field must be supplied to update.");
        var updated = (JsonObject)existing.DeepClone();
        var action = args.ContainsKey("action")
            ? args["action"]
            : existing["action"] ?? JsonValue.Create("message");
        var switched =
            MainTimers.Text(action) != (MainTimers.Text(existing["action"]) ?? "message");
        var payload = (JsonObject)args.DeepClone();
        payload["action"] = action?.DeepClone();
        if (!args.ContainsKey("message") && !switched)
            payload["message"] =
                existing["message"]?.DeepClone()
                ?? (TimerArguments.Script(existing) ? JsonValue.Create("") : null);
        if (!args.ContainsKey("script") && !switched && existing.ContainsKey("script"))
            payload["script"] = existing["script"]?.DeepClone();
        TimerArguments.PutAction(updated, payload);
        if (switched || TimerArguments.Script(updated))
        {
            updated["newSession"] = false;
            foreach (
                var key in new[] { "sessionPrefix", "agentName", "currentNode", "model", "effort" }
            )
                updated.Remove(key);
        }
        if (schedule.Provided)
        {
            PutSchedule(updated, schedule);
            updated.Remove("lastTriggeredAt");
        }
        if (TimerArguments.Script(updated))
            return updated;
        var fresh = newSession
            ? Flag(args["newSession"])
            : !switched && Flag(existing["newSession"]);
        updated["newSession"] = fresh;
        if (!fresh)
        {
            if (changedTarget)
                throw new InvalidDataException(
                    "sessionPrefix and agentName may only be supplied when newSession=true."
                );
            foreach (
                var key in new[] { "sessionPrefix", "agentName", "currentNode", "model", "effort" }
            )
                updated.Remove(key);
            return updated;
        }
        updated["sessionPrefix"] = TimerArguments.Optional(args["sessionPrefix"]) is null
            ? Text(existing["sessionPrefix"]) ?? "timer"
            : TimerArguments.Prefix(args["sessionPrefix"]);
        updated["agentName"] =
            TimerArguments.Optional(args["agentName"])
            ?? Text(existing["agentName"])
            ?? Text(owner["agent"])
            ?? "main";
        foreach (var key in new[] { "currentNode", "model", "effort" })
            if (existing[key] is null && owner[key] is not null)
                updated[key] = owner[key]!.DeepClone();
        return updated;
    }

    private static void PutSchedule(JsonObject row, TimerArguments.Schedule schedule)
    {
        row.Remove("at");
        row.Remove("cron");
        if (schedule.At is double at)
            row["at"] = at;
        if (schedule.Cron is string cron)
            row["cron"] = cron;
    }
}
