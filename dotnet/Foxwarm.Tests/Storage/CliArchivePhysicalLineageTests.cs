using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CliArchiveMigrationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Physical_Source_fork_retains_inherited_context_before_or_after_accepted_catalog_load(
        bool loadCatalog
    )
    {
        using var temp = new TempDirectory();
        var fixture = await Source("seed", temp.Path, "with-cold-session");
        var root = fixture["legacy"]!.GetValue<string>();
        var parent = fixture["parentId"]!.GetValue<string>();
        var child = fixture["childId"]!.GetValue<string>();
        var cold = fixture["coldId"]!.GetValue<string>();
        var archive = new SqliteArchiveMessageStore(Database(root), child);
        Assert.Null(archive.ReadBranch());
        if (loadCatalog)
        {
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"), "wire", "fixture/wire", "", "", 713
            );
            var workspace = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(workspace);
            await using var manager = new SessionManager(root, workspace, options, HostModels.ForTest(options));
            await manager.LoadAsync();
            Assert.Empty(manager.Owners());
            Assert.True(File.Exists(Path.Combine(root, "state/catalog.sqlite")));
            Assert.False(File.Exists(Path.Combine(root, "state/sessions.json")));
            Assert.Null(archive.ReadBranch());
        }
        Assert.True(File.Exists(Path.Combine(root, "state/logs/sessions", child + ".jsonl")));
        Assert.False(File.Exists(Path.Combine(root, "state/logs/sessions", cold + ".jsonl")));
        Assert.False(File.Exists(Path.Combine(root, "state/logs/sessions", cold + ".blocks.jsonl")));
        var sourceRoot = Path.Combine(temp.Path, "source-reader");
        CopyTree(root, sourceRoot);
        var source = await Source("migrate", sourceRoot);
        await Migrate(root);
        var branch = archive.ReadBranch()!;
        Assert.Equal(parent, branch.ParentSessionId);
        Assert.Equal(2, branch.MessageCap);
        Assert.Equal(1, branch.BlockCap);
        Assert.Equal(parent, source["childBranch"]!["parentSessionId"]!.GetValue<string>());
        Assert.Equal(branch.MessageCap, source["childBranch"]!["forkMessageSeq"]!.GetValue<double>());
        Assert.Equal(branch.BlockCap, source["childBranch"]!["forkBlockId"]!.GetValue<double>());
        var effective = archive.ReadEffectiveMessagesRange(1, 100);
        Assert.Equal(new long[] { 1, 2, 3, 4, 5 }, effective.Select(row => row.Seq));
        Assert.All(effective.Take(2), row => Assert.Equal(parent, row.SessionId));
        Assert.All(effective.Skip(2), row => Assert.Equal(child, row.SessionId));
        Assert.Equal(parent, Assert.Single(archive.ReadEffectiveBlocksRange(1, 100)).SessionId);
        var expanded = new ArchiveContextReader(archive).Expand(child, 1, 1000)!;
        Assert.Equal(2, expanded["totalItems"]!.GetValue<int>());
        Assert.All(expanded["items"]!.AsArray(), item =>
        {
            Assert.True(item!["inherited"]!.GetValue<bool>());
            Assert.Equal(parent, item["sourceSessionId"]!.GetValue<string>());
        });
        Assert.Contains("Original 漢字", expanded["messages"]![0]!["parts"]![0]!["text"]!.GetValue<string>());
        var export = Path.Combine(temp.Path, "export");
        await SqliteArchiveMessageStore.ExportJsonlAsync(Database(root), export);
        var local = File.ReadAllLines(Path.Combine(export, child + ".jsonl"))
            .Select(line => JsonNode.Parse(line)!).ToArray();
        Assert.Equal(new double[] { 3, 4, 5 }, local.Select(row => row["seq"]!.GetValue<double>()));
        Assert.All(local, row => Assert.Equal(child, row["sessionId"]!.GetValue<string>()));
        Assert.True(File.Exists(Path.Combine(root, "state/migrationVersion.json")));
        // A real catalog member without a legacy file is not an import candidate.
        Assert.False(File.Exists(Path.Combine(root, "state/logs/sessions", cold + ".jsonl")));
        var coldBranch = new SqliteArchiveMessageStore(Database(root), cold).ReadBranch();
        if (loadCatalog)
            Assert.Null(coldBranch);
        else
            Assert.NotNull(coldBranch); // Source metadata bootstrap retains its existing behavior.
    }
}