using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TaskCompletionDeliveryTests
{
    [Fact]
    public async Task Completion_delivers_full_stored_result_and_reopen_does_not_resend_terminal_task()
    {
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        SessionManager Manager()
        {
            var manager = new SessionManager(
                Path.Combine(temp.Path, "data"),
                Path.Combine(temp.Path, "work"),
                options,
                HostModels.ForTest(options)
            );
            // Keep normal queue admission and persistence, without starting provider turns.
            manager.TopologyChanged += () =>
            {
                foreach (var owner in manager.Owners())
                    owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            };
            return manager;
        }
        var result = new string('R', 6000) + "TAIL_CONCLUSION_RETAIN_ME";
        string taskId;
        string creatorId;
        string workerId;
        void CheckNotification(SessionOwner creator)
        {
            var notice = Assert.Single(creator.Entry.Snapshot().Queue);
            Assert.True(notice.Trigger);
            var text = SessionWait.Text(Assert.Single(notice.Parts!)["system"]);
            Assert.Contains(result, text);
            Assert.Contains("event=\"completed\"", text);
            Assert.Contains(taskId, text);
        }
        await using (var manager = Manager())
        {
            await manager.LoadAsync();
            var creator = await manager.CreateNamedAsync("main", "creator", null, null);
            var worker = await manager.CreateNamedAsync("main", "worker", null, null);
            creatorId = creator.Id;
            workerId = worker.Id;
            var created = (await manager.Tasks.ExecuteAsync(
                new JsonObject
                {
                    ["action"] = "create",
                    ["title"] = "complete report",
                    ["ownerSessionId"] = worker.Id,
                    ["notifySession"] = true,
                },
                creator.Id
            )).Payload;
            taskId = created["task"]!["id"]!.GetValue<string>();
            Assert.Equal(1, created["sentNotifications"]!.GetValue<int>());
            var completed = await manager.Tasks.ExecuteForToolWithReceiptAsync(
                worker,
                new JsonObject
                {
                    ["action"] = "complete",
                    ["taskId"] = taskId,
                    ["result"] = result,
                }
            );
            Assert.Equal(creator.Id, completed.CompletionTarget);
            Assert.Equal("completed", SessionWait.Text(completed.Payload["task"]?["status"]));
            Assert.Equal(result, SessionWait.Text(completed.Payload["task"]?["result"]));
            Assert.Equal("sent", SessionWait.Text(completed.Payload["task"]?["completionNotificationStatus"]));
            Assert.Equal(1, completed.Payload["sentNotifications"]!.GetValue<int>());
            Assert.Null(completed.Payload["warning"]);
            CheckNotification(creator);
            Assert.Single(worker.Entry.Snapshot().Queue);
            await manager.ShutdownAsync();
        }
        await using (var manager = Manager())
        {
            await manager.LoadAsync();
            var creator = await manager.RequiredAsync(creatorId);
            var worker = await manager.RequiredAsync(workerId);
            var stored = (await manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "get", ["taskId"] = taskId },
                null
            )).Payload["task"]!;
            Assert.Equal(result, SessionWait.Text(stored["result"]));
            Assert.Equal("sent", SessionWait.Text(stored["completionNotificationStatus"]));
            CheckNotification(creator);
            var error = await Assert.ThrowsAsync<TaskError>(() => manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "complete", ["taskId"] = taskId, ["result"] = "do not resend" },
                worker.Id
            ));
            Assert.Equal("TASK_TERMINAL", error.Code);
            CheckNotification(creator);
            Assert.Single(worker.Entry.Snapshot().Queue);
            await manager.ShutdownAsync();
        }
    }
}
