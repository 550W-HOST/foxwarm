using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TaskReminderHistoryTests
{
    private const string ReminderText = "Continue the active tasks:";

    private static HttpResponseMessage Success() =>
        new(HttpStatusCode.OK)
        {
            Content = new StringContent(
                "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n",
                Encoding.UTF8,
                "text/event-stream"
            ),
        };

    private static HttpResponseMessage Failure(HttpStatusCode status) =>
        new(status)
        {
            Content = new StringContent("{\"error\":{\"message\":\"owned provider rejection\"}}"),
        };

    private static int Occurrences(string text, string value)
    {
        var count = 0;
        for (
            var index = text.IndexOf(value, StringComparison.Ordinal);
            index >= 0;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal)
        )
            count++;
        return count;
    }

    private static HistoryMessage[] Reminders(IEnumerable<HistoryMessage> history) =>
        history
            .Where(row =>
                row.Data.TryGetProperty("__meta", out var meta)
                && meta.TryGetProperty(TaskReminder.MetaKey, out var flag)
                && flag.ValueKind == JsonValueKind.True
            )
            .ToArray();

    private static string Role(HistoryMessage row) => row.Data.GetProperty("role").GetString()!;

    /// <summary>Runs ordinary user turns; each adds one user and one model visible message.</summary>
    private static async Task Turns(Fixture fixture, int count)
    {
        for (var turn = 0; turn < count; turn++)
        {
            await fixture.Enqueue($"turn {fixture.Turns++}");
            await fixture.Run();
        }
    }

    [Fact]
    public async Task Due_reminder_is_appended_once_before_its_request_and_sent_as_plain_history()
    {
        using var root = new TempDirectory();
        using var fixture = new Fixture(root.Path, _ => Success());
        await fixture.CreateTaskAsync("Ship the release");

        // Before the 16th request only 29 ordinary visible messages exist after the anchor.
        await Turns(fixture, 15);
        Assert.Empty(Reminders(fixture.History()));
        Assert.All(fixture.Bodies, body => Assert.DoesNotContain(ReminderText, body));

        await Turns(fixture, 1);
        var history = fixture.History();
        var reminder = Assert.Single(Reminders(history));
        var index = Array.IndexOf(history, reminder);
        Assert.Equal("user", Role(history[index - 1]));
        Assert.Equal(
            "turn 15",
            history[index - 1].Data.GetProperty("parts")[0].GetProperty("text").GetString()
        );
        Assert.Equal("model", Role(history[index + 1]));
        Assert.Equal(index, history.Length - 2);
        var system = reminder.Data.GetProperty("parts")[0].GetProperty("system").GetString()!;
        Assert.StartsWith(
            $"<foxwarm-system kind=\"task-reminder\" seq=\"{reminder.Sequence}\">{ReminderText}\n{fixture.TaskId} — Ship the release (active)",
            system
        );
        Assert.EndsWith("</foxwarm-system>", system);
        Assert.Equal(1, Occurrences(fixture.Bodies[^1], ReminderText));

        // The persisted row remains ordinary history for later requests and is not request-only context.
        await Turns(fixture, 1);
        Assert.Single(Reminders(fixture.History()));
        Assert.Equal(1, Occurrences(fixture.Bodies[^1], ReminderText));

        // Persisted to the authority JSON, not only the live state.
        var reloaded = (await fixture.Store.LoadAsync("s"))!;
        Assert.Single(Reminders(reloaded.History));
    }

    [Fact]
    public async Task Reminder_row_does_not_count_towards_the_next_interval()
    {
        using var root = new TempDirectory();
        using var fixture = new Fixture(root.Path, _ => Success());
        await fixture.CreateTaskAsync("Ship the release");
        await Turns(fixture, 16);
        var reminder = Assert.Single(Reminders(fixture.History()));
        Assert.False(TaskProgress.IsOrdinaryVisible(reminder));
        Assert.DoesNotContain(reminder.Sequence!.Value, TaskProgress.Sequences(fixture.History()));

        // After the reminder (counted through the user message before it) the next one needs
        // 30 more ordinary messages: the 31st request, not earlier.
        await Turns(fixture, 14);
        Assert.Single(Reminders(fixture.History()));
        await Turns(fixture, 1);
        Assert.Equal(2, Reminders(fixture.History()).Length);
    }

    [Fact]
    public async Task Provider_retry_reuses_the_persisted_row_without_appending_another()
    {
        using var root = new TempDirectory();
        Fixture? current = null;
        using var fixture = current = new Fixture(
            root.Path,
            attempt =>
                attempt == current!.DueAttempt
                    ? Failure(HttpStatusCode.ServiceUnavailable)
                    : Success()
        );
        await fixture.CreateTaskAsync("Ship the release");
        await Turns(fixture, 15);
        fixture.DueAttempt = fixture.Attempts + 1;
        var before = fixture.Bodies.Count;
        await Turns(fixture, 1);

        Assert.Equal(before + 2, fixture.Attempts);
        Assert.Single(fixture.Delays);
        Assert.Single(Reminders(fixture.History()));
        Assert.Equal(1, Occurrences(fixture.Bodies[before], ReminderText));
        Assert.Equal(1, Occurrences(fixture.Bodies[before + 1], ReminderText));
        Assert.Equal("model", Role(fixture.History()[^1]));
    }

    [Fact]
    public async Task Interrupted_due_request_survives_restart_and_continue_sends_the_same_row_once()
    {
        using var root = new TempDirectory();
        var failDue = false;
        string? taskId;
        using (
            var first = new Fixture(
                root.Path,
                _ => failDue ? Failure(HttpStatusCode.BadRequest) : Success()
            )
        )
        {
            await first.CreateTaskAsync("Ship the release");
            taskId = first.TaskId;
            await Turns(first, 15);
            failDue = true;
            await Turns(first, 1);
            Assert.Single(Reminders(first.History()));
            Assert.True(first.Owner.Metadata().LlmFailed);
            // The failed request leaves the turn continuable; the reminder does not change that.
            Assert.True(SessionContinuation.IsIncomplete(first.History()));
        }

        using var second = new Fixture(root.Path, _ => Success(), restore: true);
        second.TaskId = taskId;
        var restored = second.History();
        Assert.Single(Reminders(restored));
        Assert.True(SessionContinuation.IsIncomplete(restored));

        await second.Runner.ProcessQueueAsync("s", retry: true);
        var history = second.History();
        Assert.Single(Reminders(history));
        Assert.Equal("model", Role(history[^1]));
        Assert.Equal(1, Occurrences(Assert.Single(second.Bodies), ReminderText));
        Assert.False(SessionContinuation.IsIncomplete(history));

        // Restarted progress is retained: the next reminder still needs a full new interval.
        second.Turns = 16;
        await Turns(second, 14);
        Assert.Single(Reminders(second.History()));
        await Turns(second, 1);
        Assert.Equal(2, Reminders(second.History()).Length);
    }

    [Fact]
    public async Task Idle_due_progress_and_auxiliary_requests_neither_wake_nor_consume_the_reminder()
    {
        using var root = new TempDirectory();
        using var fixture = new Fixture(root.Path, _ => Success());
        await fixture.CreateTaskAsync("Ship the release");
        await Turns(fixture, 15);
        var attempts = fixture.Attempts;

        // 30 ordinary visible messages now exist. A compaction checkpoint counts them without delivery.
        fixture.Tasks.TaskContext("s", TaskProgress.Sequences(fixture.History()), false);
        await fixture.Requests.RequestAsync(
            "s",
            fixture.Models,
            fixture.Models.DefaultKey,
            null,
            "cache",
            "turn",
            fixture.Owner.History(),
            (_, _) => Task.FromResult("instructions"),
            null,
            null,
            null,
            null,
            default,
            ModelRequestScope.CompactPlan
        );
        Assert.Equal(attempts + 1, fixture.Attempts);
        Assert.DoesNotContain(ReminderText, fixture.Bodies[^1]);
        await Task.Delay(100);
        var snapshot = fixture.Owner.Entry.Snapshot();
        Assert.False(snapshot.Busy);
        Assert.Empty(snapshot.Queue);
        Assert.Empty(Reminders(snapshot.History));
        Assert.Equal(attempts + 1, fixture.Attempts);

        // The next normal request receives the still-due reminder.
        await Turns(fixture, 1);
        Assert.Single(Reminders(fixture.History()));
        Assert.Equal(1, Occurrences(fixture.Bodies[^1], ReminderText));
    }

    [Fact]
    public void Continue_classification_ignores_a_trailing_generated_reminder()
    {
        static JsonObject User(string text) =>
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            };
        static JsonObject Model(string text) =>
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            };
        static JsonObject Call(string id, string name) =>
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = id,
                            ["name"] = name,
                            ["args"] = new JsonObject(),
                        },
                    }
                ),
            };
        static JsonObject Result(string id, string name) =>
            new()
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = id,
                            ["name"] = name,
                            ["response"] = new JsonObject { ["output"] = "ok" },
                        },
                    }
                ),
            };
        var context = new JsonObject
        {
            ["tasks"] = new JsonArray(
                new JsonObject
                {
                    ["id"] = "task_0123456789ab",
                    ["title"] = "Ship",
                    ["status"] = "active",
                }
            ),
            ["omitted"] = 0,
        };
        JsonObject Reminder(int seq)
        {
            var row = TaskReminder.Build(context)!;
            row["__meta"]!["seq"] = seq;
            InputWrapperMetadata.StampSequence(row);
            return row;
        }

        Assert.False(SessionContinuation.IsIncomplete([User("go"), Model("done"), Reminder(3)]));
        Assert.True(SessionContinuation.IsIncomplete([Model("done"), User("go"), Reminder(3)]));
        Assert.True(
            SessionContinuation.IsIncomplete([Call("r", "read"), Result("r", "read"), Reminder(3)])
        );
        Assert.False(
            SessionContinuation.IsIncomplete([Call("w", "wait"), Result("w", "wait"), Reminder(3)])
        );
        Assert.False(
            SessionContinuation.IsIncomplete([
                User("go"),
                Model("done"),
                TaskReminder.Build(context)!,
            ])
        );

        var unflagged = Reminder(3);
        unflagged["__meta"]!.AsObject().Remove(TaskReminder.MetaKey);
        Assert.True(SessionContinuation.IsIncomplete([User("go"), Model("done"), unflagged]));
        var extra = Reminder(3);
        extra["parts"]!.AsArray().Add(new JsonObject { ["text"] = "more" });
        Assert.True(SessionContinuation.IsIncomplete([User("go"), Model("done"), extra]));
        Assert.Null(
            TaskReminder.Build(new JsonObject { ["tasks"] = new JsonArray(), ["omitted"] = 0 })
        );
    }

    private sealed class Peer(Fixture fixture) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        )
        {
            var attempt = ++fixture.Attempts;
            fixture.Bodies.Add(await request.Content!.ReadAsStringAsync(token));
            return fixture.Response(attempt);
        }
    }

    private sealed class Fixture : IDisposable
    {
        private readonly HttpClient http;
        internal readonly Func<int, HttpResponseMessage> Response;
        internal readonly SessionOwner Owner;
        internal readonly PersistentSessionAuthorityStore Store;
        internal readonly HostModels Models;
        internal readonly ModelRequestOwner Requests;
        internal readonly TaskService Tasks;
        internal readonly List<string> Bodies = [];
        internal readonly List<int> Delays = [];
        internal int Attempts;
        internal int DueAttempt;
        internal int Turns;
        internal string? TaskId;

        private readonly string root;

        internal Fixture(string root, Func<int, HttpResponseMessage> response, bool restore = false)
        {
            this.root = root;
            Response = response;
            Store = new PersistentSessionAuthorityStore(root, "s");
            var options = new ResponsesClientOptions(
                new Uri("http://localhost"),
                "wire",
                "a/wire",
                "",
                "",
                50
            );
            Models = HostModels.ForTest(options);
            Owner = new SessionOwner("s", "main", Models) { Archive = Store.Archive };
            http = new HttpClient(new Peer(this));
            Requests = new ModelRequestOwner(
                http,
                options,
                new ModelRouting(),
                (delay, _) =>
                {
                    Delays.Add(delay);
                    return Task.CompletedTask;
                }
            );
            Tasks = new TaskService(null!, root, id => id, _ => [], _ => null, _ => "main");
            var agents = new AgentCatalog(root, Path.Combine(root, "work"));
            var memory = new AgentMemory(agents, new Skills(agents, Path.Combine(root, "skills")));
            var chat = new SessionChatService(
                Requests,
                options,
                Owner,
                Models,
                memory,
                (_, _) => { },
                tasks: Tasks
            );
            Owner.Registry = new SessionRegistry(Store, chat);
            Owner.Registry.Add("s", restore ? Store.LoadAsync("s").GetAwaiter().GetResult() : null);
            Owner.EnableCommittedNotifications();
            Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            Owner.Registry.OnTurnFailure = (error, durable) =>
                Owner.PresentFailureAsync(error, durable);
        }

        internal SessionTurnRunner Runner => Owner.Registry.Runner;

        internal async Task CreateTaskAsync(string title)
        {
            // A self-created, self-owned active task anchored before any Session message.
            await Tasks.MigrateLegacyGoalAsync("s", title, 0);
            using var db = new Microsoft.Data.Sqlite.SqliteConnection(
                $"Data Source={Path.Combine(root, "state", "tasks.sqlite")}"
            );
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText = "SELECT id FROM tasks";
            TaskId = command.ExecuteScalar()!.ToString()!;
        }

        internal HistoryMessage[] History() =>
            Owner.Entry.WithState(state => state.History.Snapshot()).ToArray();

        internal Task Enqueue(string text) =>
            Owner.Registry.Ingress.EnqueueAsync(
                "s",
                QueueItem.UserText(text, clientMessageId: text)
            );

        internal Task Run() => Owner.Registry.Runner.ProcessQueueAsync("s");

        public void Dispose()
        {
            Tasks.Dispose();
            http.Dispose();
        }
    }
}
