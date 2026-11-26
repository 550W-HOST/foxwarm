using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tests.Hosted;

namespace Foxwarm.Tests;

public sealed partial class RequestPrefixTests
{
    /// <summary>
    /// A redacting Session whose tenant moves to another owner: the new owner, at the next lease
    /// epoch with its own stores, sends the same history byte for byte because it reads the
    /// previous owner's slot results and known values (D-request-prefix-stability).
    /// </summary>
    [Trait("Backend", "postgres")]
    public sealed class RedactionTakeover
    {
        [Fact]
        public async Task A_new_owner_sends_the_previous_owners_redacted_prefix_byte_for_byte()
        {
            using var temp = new TempDirectory();
            await using var detector = await TextRedactionStoreContractTests.DetectorAsync();
            var captures = new List<string>();
            await using var peer = new ScriptedResponsesSequenceServer(
                3,
                async (_, stream, captured) =>
                {
                    lock (captures)
                        captures.Add(captured.Body);
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes(Reply(null))
                    );
                }
            );
            var server = await PostgresServer.SharedAsync();
            await using var database = await server.CreateDatabaseAsync();
            var tenantId = await database.TenantIdAsync();

            async Task<(SessionManager Manager, ModelConfiguration Configuration)> OwnerAsync(
                string replica
            )
            {
                var epoch = await database.TakeLeaseAsync(tenantId, replica);
                var hosted = new PostgresStorageContext(
                    new TenantDb(database.OpenApp(), tenantId, epoch),
                    Path.Combine(temp.Path, "data")
                );
                return await CreateRedactingManager(
                    temp.Path,
                    peer.BaseUri,
                    detector.Endpoint,
                    HostedTestBackend.Compose(hosted, Path.Combine(temp.Path, "data")),
                    key => hosted.OpenTextRedaction(key)
                );
            }

            string sessionId;
            var (first, firstConfiguration) = await OwnerAsync("owner-1");
            await using (first)
            {
                var owner = await first.CreateNamedAsync("main", "redacted", null, null);
                sessionId = owner.Id;
                owner.Registry.TriggerOverride = _ => Task.CompletedTask;
                // Detected in context: Alice only, although Bob is a name too.
                await Append(owner, Text(TextRedactionStoreContractTests.Early));
                await Turn(owner);
                // Bob becomes a known value here.
                await Append(owner, Text("Bob is here."));
                await Turn(owner);
            }
            firstConfiguration.Secrets.Dispose();
            var calls = detector.Texts.Count;

            // The next owner takes the lease at a new epoch with its own stores.
            var (second, secondConfiguration) = await OwnerAsync("owner-2");
            await using (second)
            {
                var owner = await second.RequiredAsync(sessionId);
                owner.Registry.TriggerOverride = _ => Task.CompletedTask;
                await Append(owner, Text("Bob again, with Alice."));
                await Turn(owner);
            }
            secondConfiguration.Secrets.Dispose();

            Assert.Equal(3, captures.Count);
            var before = JsonNode.Parse(captures[1])!.AsObject();
            var after = JsonNode.Parse(captures[2])!.AsObject();
            Assert.Equal(Instructions(before), Instructions(after));
            Assert.Equal(before["tools"]!.ToJsonString(), after["tools"]!.ToJsonString());
            var earlier = before["input"]!.AsArray();
            var later = after["input"]!.AsArray();
            Assert.True(later.Count > earlier.Count);
            for (var index = 0; index < earlier.Count; index++)
                Assert.Equal(earlier[index]!.ToJsonString(), later[index]!.ToJsonString());

            // The early message kept its first form although Bob is known by now, Alice kept her
            // placeholder, and only the new text went to the detector.
            Assert.Contains("Bob joins later", captures[2]);
            Assert.DoesNotContain("Alice", captures[2]);
            Assert.DoesNotContain("Bob is here", captures[2]);
            var newTexts = detector.Texts.Skip(calls).ToArray();
            Assert.NotEmpty(newTexts);
            Assert.All(newTexts, text => Assert.DoesNotContain("joins later", text));
            Assert.All(newTexts, text => Assert.DoesNotContain("Bob is here", text));
        }
    }

    private static async Task<(SessionManager, ModelConfiguration)> CreateRedactingManager(
        string root,
        Uri uri,
        Uri detector,
        Foxwarm.Storage.IStorageContext storage,
        Func<byte[], ITextRedactionStore?> openTextRedaction
    )
    {
        var data = Path.Combine(root, "data");
        var work = Path.Combine(root, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(Path.Combine(work, "memory"));
        await File.WriteAllTextAsync(
            Path.Combine(work, "memory", "prefix.md"),
            "Stable synthetic memory."
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            new JsonObject { ["vector"] = false }.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            new JsonObject
            {
                ["default"] = "synthetic/wire",
                ["defaults"] = new JsonObject
                {
                    ["textRedaction"] = new JsonObject { ["knownLabels"] = "all" },
                },
                ["providers"] = new JsonObject
                {
                    ["synthetic"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = uri.ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["contextLimit"] = 200000,
                        ["textRedaction"] = TextRedactionTests.Settings(detector),
                    },
                },
            }.ToJsonString()
        );
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(data, root, environment: _ => null),
            openTextRedaction
        );
        var options = new ResponsesClientOptions(
            uri,
            "wire",
            "synthetic/wire",
            "",
            "Stable base instructions.",
            1000
        );
        var manager = new SessionManager(
            data,
            work,
            options,
            new HostModels(configuration),
            Path.Combine(root, "skills"),
            storage: storage
        );
        await manager.LoadMainHostAsync();
        return (manager, configuration);
    }
}
