using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CommittedAuthorityProjectionTests
{
    [Fact]
    public async Task WebUI_known_committed_creation_accepts_ordinary_ingress_and_reopens_the_same_lifetime()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var state = Path.Combine(data, "state");
        Directory.CreateDirectory(state);
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            (context, _) =>
                context.Send(
                    ResponsesPrefixCommitTests.Completed(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["phase"] = "final_answer",
                            ["content"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "output_text",
                                    ["text"] = "Committed lifetime reply.",
                                }
                            ),
                        }
                    )
                )
        );
        await File.WriteAllTextAsync(
            Path.Combine(state, "models.yaml"),
            $"""
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: {peer.Uri}
                models: [wire]
            """
        );
        string? id = null;
        string? cacheKey = null;
        for (var phase = 0; phase < 2; phase++)
        {
            var configuration = new ModelConfiguration(
                HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
            );
            var settings = await HttpServerSettings.CaptureDesktopAsync(data);
            var options = new ResponsesClientOptions(peer.Uri, "wire", "local/wire", "", "", 713);
            var failCreation = phase == 0;
            await using var manager = new SessionManager(
                data, Path.Combine(data, "agents", "main"), options, configuration.Models,
                authorityStageHook: (_, stage) =>
                {
                    if (!failCreation || stage != AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)
                        return;
                    failCreation = false;
                    throw new IOException("Owned committed creation failure.");
                });
            await manager.LoadMainHostAsync();
            await using var terminals = new Foxwarm.Terminal.TerminalRegistry(data, default);
            var server = new HttpServer([], 0, settings.Token, null, manager, terminals, webUiEnabled: true);
            var runtime = new SessionRuntime(manager);
            new Foxwarm.Channels.WebUi.WebUIChannel(manager, runtime, new MessageRouter(runtime), terminals, server.Downloads).Register(server.App);
            await using var app = server.App;
            await app.StartAsync();
            using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()) };
            client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
            if (phase == 0)
            {
                using var created = await client.PostAsJsonAsync(
                    "api/sessions",
                    new { agentId = "main", sessionId = "s_0123456789abcdef0123456789abcdef" }
                );
                Assert.Equal(HttpStatusCode.Conflict, created.StatusCode);
                var receipt = (await created.Content.ReadFromJsonAsync<JsonObject>())!;
                Assert.True(receipt["committed"]!.GetValue<bool>());
                id = receipt["sessionId"]!.GetValue<string>();
                Assert.Equal("s_0123456789abcdef0123456789abcdef", id);
                Assert.Empty(peer.Requests);
            }
            var route = "api/sessions/" + Uri.EscapeDataString(id!);
            using var exact = await client.GetAsync(route + "/state");
            Assert.Equal(HttpStatusCode.OK, exact.StatusCode);
            var path = Path.Combine(state, "sessions", id + ".json");
            var authority = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
            if (phase == 0)
            {
                Assert.Empty(authority["history"]!.AsArray());
                cacheKey = authority["promptCacheKey"]!.GetValue<string>();
            }
            else
                Assert.Equal(cacheKey, authority["promptCacheKey"]!.GetValue<string>());
            using var sent = await client.PostAsJsonAsync(
                route + "/message",
                new { text = "Ordinary input " + phase }
            );
            Assert.True(
                sent.StatusCode == HttpStatusCode.Accepted,
                await sent.Content.ReadAsStringAsync()
            );
            JsonObject history;
            var deadline = DateTime.UtcNow.AddSeconds(10);
            do
            {
                history = (await client.GetFromJsonAsync<JsonObject>(route + "/history"))!;
                if (history["messages"]!.AsArray().Count == (phase + 1) * 2)
                    break;
                await Task.Delay(10);
            } while (DateTime.UtcNow < deadline);
            var rows = history["messages"]!.AsArray();
            Assert.Equal((phase + 1) * 2, rows.Count);
            Assert.Contains("Committed lifetime reply.", rows.Last()!.ToJsonString());
            Assert.Equal(phase + 1, peer.Requests.Count);
            var archive = new SqliteArchiveMessageStore(
                Path.Combine(state, "archive-store.sqlite"),
                id!
            );
            Assert.Equal(rows.Count, archive.ReadMessages().Count);
        }
    }

    [Theory]
    [InlineData("strict", AtomicJsonWriteStage.BeforeRename)]
    [InlineData("strict", AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)]
    [InlineData("strict", AtomicJsonWriteStage.AfterDirectorySync)]
    [InlineData("append", AtomicJsonWriteStage.BeforeRename)]
    [InlineData("append", AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)]
    [InlineData("append", AtomicJsonWriteStage.AfterDirectorySync)]
    [InlineData("compact", AtomicJsonWriteStage.BeforeRename)]
    [InlineData("compact", AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)]
    [InlineData("compact", AtomicJsonWriteStage.AfterDirectorySync)]
    public async Task Known_publication_updates_durable_catalog_without_compensating_Archive(
        string operation,
        AtomicJsonWriteStage stage
    )
    {
        using var f = new PublicationFixture();
        await f.SeedAsync();
        var previous = await File.ReadAllTextAsync(f.Store.AuthorityPath);
        f.Fault = stage;
        var error = await Record.ExceptionAsync(() => f.CommitAsync(operation));
        var committed = stage != AtomicJsonWriteStage.BeforeRename;
        Assert.IsAssignableFrom<IOException>(error);
        Assert.Equal(committed, error is AuthorityCommittedException);
        Assert.Same(f.WriteError, committed ? error!.InnerException : error);
        Assert.Equal(committed ? "new" : "old", f.Catalog.Get("s")!["model"]!.GetValue<string>());
        var loaded = (await f.Store.LoadAsync("s"))!;
        Assert.Equal(
            committed ? "new" : "old",
            loaded.AuthorityEnvelope["model"]!.GetValue<string>()
        );
        if (!committed)
            Assert.Equal(previous, await File.ReadAllTextAsync(f.Store.AuthorityPath));
        Assert.Equal(
            committed && operation != "strict" ? 2 : 1,
            f.Store.Archive.ReadMessages().Count
        );
        Assert.Equal(
            committed && operation == "compact" ? 1 : 0,
            f.Store.Archive.ReadBlocks().Count
        );
        using var reopened = new SessionCatalog(f.Root.Path);
        reopened.Initialize();
        Assert.Equal(committed ? "new" : "old", reopened.Get("s")!["model"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("strict", false)]
    [InlineData("strict", true)]
    [InlineData("append", false)]
    [InlineData("append", true)]
    [InlineData("compact", false)]
    [InlineData("compact", true)]
    public async Task Failed_projection_remains_committed_with_new_JSON_and_older_catalog(
        string operation,
        bool failDurability
    )
    {
        using var f = new PublicationFixture();
        await f.SeedAsync();
        f.Fault = failDurability ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : null;
        var projectionError = new IOException("Owned projection failure.");
        f.Catalog.BeforeAuthorityProjection = _ => throw projectionError;
        var error = await Assert.ThrowsAsync<AuthorityCommittedException>(() =>
            f.CommitAsync(operation)
        );
        Assert.Equal("old", f.Catalog.Get("s")!["model"]!.GetValue<string>());
        Assert.Equal(
            "new",
            (await f.Store.LoadAsync("s"))!.AuthorityEnvelope["model"]!.GetValue<string>()
        );
        Assert.Equal(operation == "strict" ? 1 : 2, f.Store.Archive.ReadMessages().Count);
        Assert.Equal(operation == "compact" ? 1 : 0, f.Store.Archive.ReadBlocks().Count);
        if (failDurability)
        {
            var combined = Assert.IsType<AggregateException>(error.InnerException);
            Assert.Same(
                f.WriteError,
                Assert
                    .IsType<AuthorityCommittedException>(combined.InnerExceptions[0])
                    .InnerException
            );
            Assert.Same(projectionError, combined.InnerExceptions[1]);
        }
        else
            Assert.Same(projectionError, error.InnerException);
        // A later normal save can refresh the projection; this attempt does not retry it.
        f.Fault = null;
        f.Catalog.BeforeAuthorityProjection = null;
        await f.Store.CommitAsync((await f.Store.LoadAsync("s"))!, SaveKind.Strict);
        Assert.Equal("new", f.Catalog.Get("s")!["model"]!.GetValue<string>());
    }

    private sealed class PublicationFixture : IDisposable
    {
        internal TempDirectory Root { get; } = new();
        internal SessionCatalog Catalog { get; }
        internal PersistentSessionAuthorityStore Store { get; }
        internal AtomicJsonWriteStage? Fault;
        internal readonly IOException WriteError = new("Owned authority publication fault.");
        private readonly JsonObject first = Fixture.Message(1, "old input", 1000);
        private readonly JsonObject second = Fixture.Message(2, "new input", 2000);

        internal PublicationFixture()
        {
            Catalog = new(Root.Path);
            Catalog.Initialize();
            Store = new(
                Root.Path,
                "s",
                authorityStageHook: stage =>
                {
                    if (stage == Fault)
                        throw WriteError;
                },
                publishProjection: snapshot =>
                {
                    var row = SessionCatalogTests.Row("s", 0);
                    row["model"] = snapshot.AuthorityEnvelope["model"]!.DeepClone();
                    row["meta"] = snapshot.Meta.DeepClone();
                    Catalog.PublishAuthority(row, allowInsert: true);
                }
            );
        }

        private static SessionSnapshot Snapshot(string name, params JsonObject[] messages) =>
            new(
                "s",
                messages,
                [],
                false,
                null,
                false,
                new(),
                messages[^1]["__meta"]!["seq"]!.GetValue<int>() + 1,
                0,
                new() { ["model"] = name }
            );

        internal Task SeedAsync() =>
            Store.CommitCanonicalAppendAsync(Snapshot("old", first), [first]);

        internal Task CommitAsync(string operation) =>
            operation switch
            {
                "strict" => Store.CommitAsync(Snapshot("new", first), SaveKind.Strict),
                "append" => Store.CommitCanonicalAppendAsync(
                    Snapshot("new", first, second),
                    [second]
                ),
                "compact" => Store.CommitCompactionAsync(
                    Snapshot("new", second),
                    [
                        new ArchiveBlockRecord(
                            "s",
                            "main",
                            1,
                            1,
                            "message",
                            1,
                            1,
                            null,
                            1,
                            1,
                            1000,
                            1000,
                            "Owned summary.",
                            null,
                            2000
                        ),
                    ],
                    [second]
                ),
                _ => throw new ArgumentOutOfRangeException(nameof(operation)),
            };

        public void Dispose()
        {
            Catalog.Dispose();
            Root.Dispose();
        }
    }
}
