using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// A persisted prompt snapshot records the hosted profile it was built under. After a tenant
// moves to another profile, the first request of an existing Session recomposes the prompt
// once; same-profile reuse keeps the snapshot's bytes.
[Trait("Backend", "neutral")]
public sealed class PromptProfileSnapshotTests
{
    private static readonly string Bundled = Path.Combine(AppContext.BaseDirectory, "skills");

    private static HttpResponseMessage Success() =>
        new(HttpStatusCode.OK)
        {
            Content = new StringContent(
                "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n",
                Encoding.UTF8,
                "text/event-stream"
            ),
        };

    private sealed class Peer(List<string> bodies) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        )
        {
            bodies.Add(await request.Content!.ReadAsStringAsync(token));
            return Success();
        }
    }

    // One runtime over the Session's stores: masterNode and profile as the tenant's profile
    // gives them (null profile: a P1 runtime, which recorded none).
    private sealed class Runtime : IDisposable
    {
        private readonly HttpClient http;
        internal readonly SessionOwner Owner;
        internal readonly List<string> Bodies = [];

        internal Runtime(string root, bool masterNode, string? profile, bool restore)
        {
            var store = new PersistentSessionAuthorityStore(root, "s");
            var options = new ResponsesClientOptions(new Uri("http://localhost"), "wire", "a/wire", "", "", 50);
            var models = HostModels.ForTest(options);
            Owner = new SessionOwner("s", "main", models) { Archive = store.Archive };
            http = new HttpClient(new Peer(Bodies));
            var requests = TestModelOwners.Create(http, options, new ModelRouting(), (_, _) => Task.CompletedTask);
            var agents = new AgentCatalog(root, Path.Combine(root, "work"));
            Directory.CreateDirectory(agents.MemoryDirectory("main"));
            var memory = new AgentMemory(
                agents,
                new Skills(agents, Bundled, masterNode),
                masterNode: masterNode,
                profile: profile
            );
            var chat = new SessionChatService(requests, options, Owner, models, memory, (_, _) => { });
            Owner.Registry = new SessionRegistry(store, chat);
            Owner.Registry.Add("s", restore ? store.LoadAsync("s").GetAwaiter().GetResult() : null);
            Owner.EnableCommittedNotifications();
            Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        }

        internal async Task<string> TurnAsync(string text)
        {
            await Owner.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText(text, clientMessageId: text));
            await Owner.Registry.Runner.ProcessQueueAsync("s");
            return Prompt(JsonNode.Parse(Bodies[^1]))
                ?? throw new InvalidDataException("The request carries no prompt snapshot.");
        }

        // The prompt as the request carries it: the string that holds the snapshot header.
        private static string? Prompt(JsonNode? node) =>
            node switch
            {
                JsonValue value when value.TryGetValue<string>(out var text)
                    && text.Contains("<foxwarm-current-model", StringComparison.Ordinal) => text,
                JsonObject obj => obj.Select(pair => Prompt(pair.Value)).FirstOrDefault(text => text is not null),
                JsonArray array => array.Select(Prompt).FirstOrDefault(text => text is not null),
                _ => null,
            };

        internal JsonObject Envelope => Owner.Entry.Snapshot().AuthorityEnvelope;

        public void Dispose() => http.Dispose();
    }

    [Fact]
    public async Task The_first_request_after_a_profile_move_recomposes_the_prompt_once()
    {
        using var temp = new TempDirectory();
        string p1;
        using (var runtime = new Runtime(temp.Path, masterNode: false, profile: null, restore: false))
        {
            p1 = await runtime.TurnAsync("before profiles");
            Assert.False(runtime.Envelope.ContainsKey(AgentMemory.ProfileKey));
            Assert.DoesNotContain("foxwarm-maintenance", p1);
        }

        // A hosted runtime recomposes a snapshot with no profile recorded, once.
        using (var runtime = new Runtime(temp.Path, masterNode: false, profile: "hosted", restore: true))
        {
            var first = await runtime.TurnAsync("hosted first");
            Assert.Equal(p1, first);
            Assert.Equal("hosted", SessionWait.Text(runtime.Envelope[AgentMemory.ProfileKey]));
            var snapshot = SessionWait.Text(runtime.Envelope["persistentMemorySnapshot"]);
            Assert.Equal(first, await runtime.TurnAsync("hosted again"));
            Assert.Equal(snapshot, SessionWait.Text(runtime.Envelope["persistentMemorySnapshot"]));
        }

        // The tenant moves to the operator profile: the first request carries the operator's
        // prompt, not the hosted one the Session saved.
        string operatorPrompt;
        using (var runtime = new Runtime(temp.Path, masterNode: true, profile: "operator", restore: true))
        {
            // The recorded profile is persisted with the snapshot.
            Assert.Equal("hosted", SessionWait.Text(runtime.Envelope[AgentMemory.ProfileKey]));
            operatorPrompt = await runtime.TurnAsync("operator first");
            Assert.NotEqual(p1, operatorPrompt);
            Assert.Contains("foxwarm-maintenance", operatorPrompt);
            Assert.Contains("agent_folder", operatorPrompt);
            Assert.Equal("operator", SessionWait.Text(runtime.Envelope[AgentMemory.ProfileKey]));
            Assert.Equal(operatorPrompt, await runtime.TurnAsync("operator again"));
        }

        // And back: master-only skills and paths leave the prompt again.
        using (var runtime = new Runtime(temp.Path, masterNode: false, profile: "hosted", restore: true))
        {
            var back = await runtime.TurnAsync("hosted after the move back");
            Assert.DoesNotContain("foxwarm-maintenance", back);
            Assert.DoesNotContain("agent_folder", back);
            Assert.Equal(p1, back);
        }
    }

    [Fact]
    public async Task File_mode_records_no_profile_and_reuses_its_snapshot()
    {
        using var temp = new TempDirectory();
        using var runtime = new Runtime(temp.Path, masterNode: true, profile: null, restore: false);
        var first = await runtime.TurnAsync("one");
        var snapshot = SessionWait.Text(runtime.Envelope["persistentMemorySnapshot"]);
        Assert.Equal(first, await runtime.TurnAsync("two"));
        Assert.Equal(snapshot, SessionWait.Text(runtime.Envelope["persistentMemorySnapshot"]));
        Assert.False(runtime.Envelope.ContainsKey(AgentMemory.ProfileKey));
    }
}
