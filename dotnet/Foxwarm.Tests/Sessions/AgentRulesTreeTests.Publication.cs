using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class AgentRulesTreeTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Known_committed_metadata_and_publication_failure_never_restart_as_unrestricted_Agents(
        bool blockDirectory
    )
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, temp.Path, environment: _ => null);
        var work = paths.AgentsRoot;
        var armed = false;
        var catalog = new AgentCatalog(
            temp.Path,
            work,
            canonicalLayout: true,
            metadataWriteStage: stage =>
            {
                if (!armed || stage != AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)
                    return;
                if (blockDirectory)
                    File.WriteAllText(Path.Combine(work, "child"), "publication blocker");
                else
                    throw new IOException("synthetic committed durability failure");
            }
        );
        await catalog.CreateAsync("root");
        armed = true;
        var initial = Rules("""[{"tool":"skill","action":"deny"}]""");
        var failure = await Assert.ThrowsAsync<AuthorityCommittedException>(() =>
            catalog.CreateAsync(
                "child",
                initialMemory: "prepared content",
                createdBy: "root",
                rules: initial
            )
        );
        Assert.True(failure.AuthorityCommitted);
        Assert.Equal("root", catalog.CreatedBy("child"));
        Assert.True(JsonNode.DeepEquals(initial, catalog.MetadataSnapshot()["child"]!["rules"]));
        if (blockDirectory)
        {
            var prepared = Directory
                .GetDirectories(work)
                .Single(directory =>
                    Path.GetFileName(directory).StartsWith(".create-", StringComparison.Ordinal)
                );
            Assert.Equal(
                "prepared content",
                await File.ReadAllTextAsync(Path.Combine(prepared, "memory", "MEMORY.md"))
            );
            Assert.Contains(prepared, failure.Message);
            File.Delete(Path.Combine(work, "child"));
        }
        else
        {
            Assert.Equal(
                "prepared content",
                await File.ReadAllTextAsync(Path.Combine(work, "child", "memory", "MEMORY.md"))
            );
            Assert.DoesNotContain(
                Directory.GetDirectories(work),
                directory =>
                    Path.GetFileName(directory).StartsWith(".create-", StringComparison.Ordinal)
            );
        }
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            temp.Path,
            work,
            options,
            HostModels.ForTest(options),
            hostPaths: paths
        );
        await manager.LoadAsync();
        Assert.Equal("root", SessionWait.Text(manager.AgentMetadata["child"]!["createdBy"]));
        Assert.True(JsonNode.DeepEquals(initial, manager.AgentMetadata["child"]!["rules"]));
        if (blockDirectory)
        {
            Assert.DoesNotContain("child", manager.Agents());
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                manager.CreateNamedAsync("child", "main", null, null)
            );
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                manager.CreateAgentAsync("child", createMainSession: false)
            );
            Assert.Null(manager.Catalog.Get("child/main"));
        }
        else
        {
            var owner = await manager.CreateNamedAsync("child", "main", null, null);
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                manager.AuthorizeToolAsync(
                    owner,
                    new("skill", "builtin", "skill", new JsonObject { ["action"] = "list" }),
                    null,
                    default
                )
            );
        }
    }
}
