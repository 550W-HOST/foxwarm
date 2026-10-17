using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ExactReplacementTests
{
    [Theory]
    [InlineData("", "", "$&$1$$", 1, "$&$1$$")]
    [InlineData("abc", "", "x", 4, null)]
    [InlineData("abc", "missing", "x", 0, null)]
    [InlineData("one one", "one", "x", 2, null)]
    [InlineData("Abc", "abc", "x", 0, null)]
    [InlineData("aaa", "aa", "$&$1$$", 1, "$&$1$$a")]
    [InlineData("left needle right", "needle", "", 1, "left  right")]
    public void Unique_ordinal_nonoverlapping_match_keeps_replacement_literal(
        string text,
        string search,
        string replacement,
        int occurrences,
        string? updated
    )
    {
        Assert.Equal((occurrences, updated), ExactReplacement.Apply(text, search, replacement));
    }

    [Fact]
    public async Task Ordinary_edit_preserves_file_on_match_errors_and_replaces_dollars_literally()
    {
        using var temp = new TempDirectory();
        var tools = new WorkspaceTools(temp.Path);
        var path = Path.Combine(temp.Path, "ordinary.txt");
        await File.WriteAllTextAsync(path, "one one");
        foreach (var search in new[] { "missing", "one", "" })
        {
            var result = await tools.ExecuteAsync(new JsonObject
            {
                ["name"] = "edit",
                ["args"] = new JsonObject { ["filePath"] = path, ["oldText"] = search, ["newText"] = "wrong" },
            }, default);
            Assert.Equal("edit_failed", SessionWait.Text(result["error"]?["type"]));
            Assert.Equal("one one", await File.ReadAllTextAsync(path));
        }
        var edited = await tools.ExecuteAsync(new JsonObject
        {
            ["name"] = "edit",
            ["args"] = new JsonObject { ["filePath"] = path, ["oldText"] = "one one", ["newText"] = "$&$1$$" },
        }, default);
        Assert.Null(edited["error"]);
        Assert.Equal("$&$1$$", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task Owned_compact_repair_preserves_file_on_match_errors_and_replaces_dollars_literally()
    {
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
        await using var sessions = new SessionManager(
            Path.Combine(temp.Path, "data"), Path.Combine(temp.Path, "work"), options, HostModels.ForTest(options));
        await sessions.LoadAsync();
        var owner = await sessions.CreateNamedAsync("main", "repair", null, null);
        await using var repair = await CompactPlanRepairFile.CreateAsync(
            new JsonObject { ["rawArgsText"] = "one one" }, sessions, owner, default);
        JsonObject Edit(string oldText, string newText) => new()
        {
            ["name"] = "edit",
            ["args"] = new JsonObject { ["filePath"] = repair.FilePath, ["oldText"] = oldText, ["newText"] = newText },
        };
        foreach (var search in new[] { "missing", "one", "" })
        {
            await Assert.ThrowsAsync<InvalidDataException>(() => repair.ApplyAsync(Edit(search, "wrong"), default));
            Assert.Equal("one one", await repair.ReadAsync(repair.FilePath, default));
        }
        await repair.ApplyAsync(Edit("one one", "$&$1$$"), default);
        Assert.Equal("$&$1$$", await repair.ReadAsync(repair.FilePath, default));
    }
}
