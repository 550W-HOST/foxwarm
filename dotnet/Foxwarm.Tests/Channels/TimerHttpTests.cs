using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class TimerHttpTests
{
    private static Task<HttpResponseMessage> Send(
        HttpClient client,
        HttpMethod method,
        string path,
        object? body = null
    ) =>
        client.SendAsync(
            new HttpRequestMessage(method, path)
            {
                Content = body is null ? null : JsonContent.Create(body),
            }
        );

    private static async Task<JsonObject> Json(HttpResponseMessage response, HttpStatusCode status)
    {
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == status, $"{response.StatusCode}: {text}");
        return JsonNode.Parse(text)!.AsObject();
    }

    [Fact]
    public async Task Administrator_routes_list_pause_edit_inspect_and_delete_through_timer_operations_while_scoped_identities_are_denied()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state", "toolscript-runs"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            """
            access:
              identities:
                reader:
                  token: synthetic-timer-reader
                  surfaces:
                    webui: {sessions: [lead]}
            """
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            """
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: http://127.0.0.1:1/v1
                models: [wire]
            """
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "timers.json"),
            new JsonObject
            {
                ["timers"] = new JsonArray(
                    new JsonObject
                    {
                        ["id"] = "msg1",
                        ["sessionId"] = "lead",
                        ["message"] = "daily check",
                        ["cron"] = "0 0 1 1 *",
                        ["newSession"] = false,
                        ["createdAt"] = 1,
                    },
                    new JsonObject
                    {
                        ["id"] = "script1",
                        ["sessionId"] = "worker",
                        ["message"] = "",
                        ["action"] = "toolscript",
                        ["script"] = new JsonObject
                        {
                            ["code"] = "print('checked')",
                            ["mode"] = "foreground",
                            ["timeoutSecs"] = 30,
                        },
                        ["cron"] = "0 0 1 1 *",
                        ["createdAt"] = 2,
                        ["recentRuns"] = new JsonArray(
                            new JsonObject
                            {
                                ["at"] = 10,
                                ["outcome"] = "completed",
                                ["runId"] = "tsr_fixture",
                            }
                        ),
                    }
                ),
            }.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "toolscript-runs", "tsr_fixture.json"),
            new JsonObject
            {
                ["runId"] = "tsr_fixture",
                ["ownerSessionId"] = "worker",
                ["status"] = "completed",
                ["mode"] = "foreground",
                ["stdout"] = "checked\n",
                ["createdAt"] = 10,
                ["updatedAt"] = 11,
            }.ToJsonString()
        );
        var config = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        using var admin = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        using var scoped = new HttpClient { BaseAddress = admin.BaseAddress };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-timer-reader");
        foreach (var id in new[] { "lead", "worker" })
        {
            var created = await admin.PostAsJsonAsync(
                "api/sessions",
                new { agentId = "main", sessionId = id }
            );
            Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        }

        // Scoped identities see and change no timers, including their own Session's.
        Assert.Equal(HttpStatusCode.Forbidden, (await scoped.GetAsync("api/timers")).StatusCode);
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (await scoped.GetAsync("api/timers?sessionId=lead")).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (
                await Send(
                    scoped,
                    HttpMethod.Patch,
                    "api/timers/msg1",
                    new { sessionId = "lead", paused = true }
                )
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (
                await Send(scoped, HttpMethod.Delete, "api/timers/msg1", new { sessionId = "lead" })
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.Forbidden,
            (
                await scoped.GetAsync("api/timers/script1/runs/tsr_fixture?sessionId=worker")
            ).StatusCode
        );

        var all = await Json(await admin.GetAsync("api/timers"), HttpStatusCode.OK);
        Assert.Equal(
            ["msg1", "script1"],
            all["timers"]!.AsArray().Select(row => row!["id"]!.ToString()).Order()
        );
        var lead = await Json(await admin.GetAsync("api/timers?sessionId=lead"), HttpStatusCode.OK);
        var row = Assert.Single(lead["timers"]!.AsArray())!;
        Assert.False(row["paused"]!.GetValue<bool>());
        Assert.NotNull(row["nextRunAt"]);
        Assert.Empty(row["recentRuns"]!.AsArray());
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await admin.GetAsync("api/timers?agent=main")).StatusCode
        );

        var paused = await Json(
            await Send(
                admin,
                HttpMethod.Patch,
                "api/timers/msg1",
                new { sessionId = "lead", paused = true }
            ),
            HttpStatusCode.OK
        );
        Assert.True(paused["timer"]!["paused"]!.GetValue<bool>());
        Assert.Null(paused["timer"]!["nextRunAt"]);
        var stored = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(data, "state", "timers.json"))
        )!["timers"]!
            .AsArray()
            .Single(item => item!["id"]!.ToString() == "msg1")!;
        Assert.True(stored["paused"]!.GetValue<bool>());

        // Edits use update_timer validation: exactly one schedule, and the owner must match.
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await Send(
                    admin,
                    HttpMethod.Patch,
                    "api/timers/msg1",
                    new
                    {
                        sessionId = "lead",
                        cron = "0 9 * * *",
                        afterSeconds = 60,
                    }
                )
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await Send(
                    admin,
                    HttpMethod.Patch,
                    "api/timers/msg1",
                    new { sessionId = "lead", cron = "not a schedule" }
                )
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await Send(
                    admin,
                    HttpMethod.Patch,
                    "api/timers/msg1",
                    new { sessionId = "worker", message = "x" }
                )
            ).StatusCode
        );
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await Send(
                    admin,
                    HttpMethod.Patch,
                    "api/timers/msg1",
                    new { sessionId = "lead", unknown = 1 }
                )
            ).StatusCode
        );
        var edited = await Json(
            await Send(
                admin,
                HttpMethod.Patch,
                "api/timers/msg1",
                new
                {
                    sessionId = "lead",
                    cron = "30 8 * * 1-5",
                    message = "weekday check",
                }
            ),
            HttpStatusCode.OK
        );
        Assert.Equal("30 8 * * 1-5", edited["timer"]!["cron"]!.ToString());
        Assert.Equal("weekday check", edited["timer"]!["message"]!.ToString());
        Assert.True(edited["timer"]!["paused"]!.GetValue<bool>());
        var script = await Json(
            await Send(
                admin,
                HttpMethod.Patch,
                "api/timers/script1",
                new { sessionId = "worker", script = new { code = "print('v2')", timeoutSecs = 5 } }
            ),
            HttpStatusCode.OK
        );
        Assert.Equal("print('v2')", script["timer"]!["script"]!["code"]!.ToString());
        Assert.Single(script["timer"]!["recentRuns"]!.AsArray());

        var run = await Json(
            await admin.GetAsync("api/timers/script1/runs/tsr_fixture?sessionId=worker"),
            HttpStatusCode.OK
        );
        Assert.Equal("completed", run["run"]!["status"]!.ToString());
        Assert.Equal("checked\n", run["run"]!["stdout"]!.ToString());
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await admin.GetAsync("api/timers/msg1/runs/tsr_fixture?sessionId=lead")).StatusCode
        );

        Assert.Equal(
            HttpStatusCode.BadRequest,
            (
                await Send(
                    admin,
                    HttpMethod.Delete,
                    "api/timers/msg1",
                    new { sessionId = "worker" }
                )
            ).StatusCode
        );
        var deleted = await Json(
            await Send(admin, HttpMethod.Delete, "api/timers/msg1", new { sessionId = "lead" }),
            HttpStatusCode.OK
        );
        Assert.True(deleted["deleted"]!.GetValue<bool>());
        Assert.Equal(
            HttpStatusCode.NotFound,
            (
                await Send(admin, HttpMethod.Delete, "api/timers/msg1", new { sessionId = "lead" })
            ).StatusCode
        );
        var remaining = await Json(await admin.GetAsync("api/timers"), HttpStatusCode.OK);
        Assert.Equal("script1", Assert.Single(remaining["timers"]!.AsArray())!["id"]!.ToString());
    }
}
