using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TaskOwnedSourceTests
{
    [Fact]
    public async Task Actual_source_owned_scope_excludes_creator_only_and_follows_claim_assignment_release_user_and_moved_aliases()
    {
        using var temp = new TempDirectory();
        var aliases = new Dictionary<string, string> { ["old"] = "alpha", ["self"] = "alpha" };
        string Resolve(string id) => aliases.GetValueOrDefault(id, id);
        using var store = new TaskStore(Path.Combine(temp.Path, "native"), Resolve,
            id => aliases.Where(pair => pair.Value == id).Select(pair => pair.Key).ToArray());
        var steps = new JsonArray();
        void Step(string args, string? actor = "alpha", string? key = null, bool user = false) => steps.Add(new JsonObject
        {
            ["args"] = JsonNode.Parse(args), ["actor"] = actor, ["key"] = key, ["user"] = user,
        });
        Step("""{"action":"create","title":"creator-only","ownerSessionId":"beta"}""", "old", "creator");
        Step("""{"action":"create","title":"owner-only","ownerSessionId":"self"}""", "beta", "owned");
        Step("""{"action":"create","title":"unowned"}""", "old", "unowned");
        Step("""{"action":"create","title":"user-owned","ownerSessionId":"old","notifySession":false}""", null, "user", true);
        Step("""{"action":"create","title":"foreign","ownerSessionId":"gamma"}""", "gamma", "foreign");
        Step("""{"action":"list","scope":"owned"}""", "self");
        Step("""{"action":"list","scope":"current-session"}""");
        Step("""{"action":"list","scope":"current-agent"}""");
        steps[^1]!["scopeIds"] = new JsonArray("alpha", "beta");
        Step("""{"action":"list","scope":"all"}""");
        Step("""{"action":"claim","taskId":"unowned"}""");
        Step("""{"action":"list","scope":"owned","status":"active"}""");
        Step("""{"action":"assign","taskId":"owned","ownerSessionId":"beta"}""");
        Step("""{"action":"list","scope":"owned"}""");
        Step("""{"action":"assign","taskId":"user","ownerSessionId":null}""");
        Step("""{"action":"list","scope":"owned"}""");
        steps.Add(new JsonObject { ["move"] = new JsonArray("alpha", "moved") });
        Step("""{"action":"list","scope":"owned"}""", "old");
        Step("""{"action":"get","taskId":"unowned"}""", "self");
        Step("""{"action":"complete","taskId":"unowned"}""", "old");
        Step("""{"action":"list","scope":"owned","status":"completed"}""", "moved");
        for (var n = 0; n < 52; n++)
            Step($$"""{"action":"create","title":"bounded-{{n:D2}}","ownerSessionId":"old"}""", "beta");
        Step("""{"action":"list","scope":"owned"}""", "old");
        steps[^1]!["limit"] = 1;
        Step("""{"action":"list","scope":"owned"}""", "old");
        steps[^1]!["limit"] = 50;
        var ids = new Dictionary<string, string>();
        var checks = new JsonArray();
        foreach (var step in steps.OfType<JsonObject>())
        {
            if (step["move"] is JsonArray move)
            {
                var before = move[0]!.GetValue<string>();
                var after = move[1]!.GetValue<string>();
                foreach (var key in aliases.Where(pair => pair.Value == before).Select(pair => pair.Key).ToArray())
                    aliases[key] = after;
                aliases[before] = after;
                checks.Add((JsonNode?)null);
                continue;
            }
            var args = step["args"]!.DeepClone().AsObject();
            if (SessionWait.Text(args["taskId"]) is string reference)
                args["taskId"] = ids.GetValueOrDefault(reference, reference);
            try
            {
                var result = step["user"]!.GetValue<bool>() ? store.ExecuteAsUser(args).Payload
                    : store.Execute(args, SessionWait.Text(step["actor"]), step["limit"]?.GetValue<int>(),
                        scopeSessionIds: (step["scopeIds"] as JsonArray)?.Select(value => value!.GetValue<string>()).ToArray()).Payload;
                if (SessionWait.Text(step["key"]) is string key)
                    ids[key] = result["task"]!["id"]!.GetValue<string>();
                if (result["tasks"] is JsonArray tasks)
                {
                    var check = new JsonObject { ["total"] = result["total"]!.DeepClone(), ["omitted"] = result["omitted"]!.DeepClone(), ["count"] = tasks.Count };
                    if (!step.ContainsKey("limit"))
                        check["tasks"] = new JsonArray(tasks.OrderBy(task => SessionWait.Text(task!["title"]), StringComparer.Ordinal).Select(task => (JsonNode?)new JsonArray(new[] { "title", "createdByKind", "createdBySessionId", "ownerSessionId", "status" }.Select(key => task![key]?.DeepClone()).ToArray())).ToArray());
                    checks.Add(check);
                }
                else
                    checks.Add(new JsonObject { ["owner"] = result["task"]!["ownerSessionId"]?.DeepClone(), ["creator"] = result["task"]!["createdBySessionId"]?.DeepClone(), ["status"] = result["task"]!["status"]?.DeepClone() });
            }
            catch (TaskError error) { checks.Add(new JsonObject { ["error"] = error.Code }); }
        }
        var repository = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!;
        var input = Path.Combine(temp.Path, "input.json");
        var output = Path.Combine(temp.Path, "output.json");
        await File.WriteAllTextAsync(input, steps.ToJsonString());
        var info = new ProcessStartInfo("node") { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false };
        foreach (var arg in new[] { Path.Combine(repository, "dotnet", "task-policy-fixture-ts.mjs"), temp.Path, input, output }) info.ArgumentList.Add(arg);
        using var process = Process.Start(info)!;
        var stderr = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await stderr + await stdout);
        var expected = JsonNode.Parse(await File.ReadAllTextAsync(output))!.AsArray();
        for (var i = 0; i < steps.Count; i++)
            Assert.True(JsonNode.DeepEquals(expected[i], checks[i]), $"Step {i}: {steps[i]}; source={expected[i]}; native={checks[i]}");
        Assert.Equal(1, checks[^2]!["count"]!.GetValue<int>());
        Assert.Equal(50, checks[^1]!["count"]!.GetValue<int>());
    }
}
