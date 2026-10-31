using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class UnifiedEditTests
{
    private static JsonObject Args(string json) => JsonNode.Parse(json)!.AsObject();

    [Fact]
    public void Original_source_matching_supports_literal_values_adjacent_ranges_and_nonoverlapping_occurrences()
    {
        Assert.Equal(
            "ba",
            UnifiedEdit
                .Parse(
                    Args("""{"filePath":"file","oldText":"aa","newText":"b","replaceAll":true}""")
                )
                .Apply("aaa")
        );
        Assert.Equal(
            "XYef",
            UnifiedEdit
                .Parse(
                    Args(
                        """{"filePath":"file","edits":[{"oldText":"ab","newText":"X"},{"oldText":"cd","newText":"Y"}]}"""
                    )
                )
                .Apply("abcdef")
        );
        Assert.Equal(
            "β\r\n\r$&\n",
            UnifiedEdit
                .Parse(
                    Args(
                        """{"filePath":"file","edits":[{"oldText":"α","newText":"β"},{"oldText":"β","newText":""},{"oldText":"γ","newText":"$&"}]}"""
                    )
                )
                .Apply("α\r\nβ\rγ\n")
        );
        Assert.Throws<InvalidDataException>(() =>
            UnifiedEdit
                .Parse(Args("""{"filePath":"file","oldText":"x","newText":"","replaceAll":true}"""))
                .Apply("absent")
        );
        Assert.Throws<InvalidDataException>(() =>
            UnifiedEdit
                .Parse(Args("""{"filePath":"file","oldText":"a","newText":"b"}"""))
                .Apply("a a")
        );
        Assert.Throws<InvalidDataException>(() =>
            UnifiedEdit
                .Parse(
                    Args(
                        """{"filePath":"file","edits":[{"oldText":"ab","newText":""},{"oldText":"bc","newText":""}]}"""
                    )
                )
                .Apply("abc")
        );
    }

    [Theory]
    [InlineData("{\"filePath\":\"file\",\"oldText\":\"\",\"newText\":\"\"}")]
    [InlineData("{\"filePath\":\"file\",\"oldText\":\"a\"}")]
    [InlineData("{\"filePath\":\"file\",\"oldText\":\"a\",\"newText\":\"\",\"replaceAll\":null}")]
    [InlineData("{\"filePath\":\"file\",\"edits\":[]}")]
    [InlineData("{\"filePath\":\"file\",\"edits\":[null]}")]
    [InlineData(
        "{\"filePath\":\"file\",\"edits\":[{\"oldText\":\"a\",\"newText\":\"\"}],\"replaceAll\":true}"
    )]
    [InlineData("{\"apply_patch\":\"patch\",\"filePath\":\"file\"}")]
    [InlineData("{\"apply_patch\":\"patch\",\"replaceAll\":false}")]
    public void Invalid_or_mixed_forms_reject(string json) =>
        Assert.Throws<InvalidDataException>(() => UnifiedEdit.Parse(Args(json)));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Main_and_Cli_apply_literal_edits_and_leave_file_unchanged_on_batch_conflict(
        bool cli
    )
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "input.txt");
        await File.WriteAllTextAsync(path, "first second\r\n");
        var native = new NodeFileTools(new NodePaths(temp.Path));
        var main = new WorkspaceTools(temp.Path);
        async Task<JsonObject> Call(JsonObject args) =>
            cli
                ? await native.Execute("edit", args, "main", temp.Path, false)
                : await main.ExecuteAsync(
                    new JsonObject { ["name"] = "edit", ["args"] = args },
                    default
                );
        var invalid = Args(
            """{"filePath":"input.txt","edits":[{"oldText":"first","newText":"changed"},{"oldText":"absent","newText":""}]}"""
        );
        if (cli)
            await Assert.ThrowsAsync<InvalidDataException>(() => Call(invalid));
        else
            Assert.NotNull((await Call(invalid))["error"]);
        Assert.Equal("first second\r\n", await File.ReadAllTextAsync(path));
        var result = await Call(
            Args(
                """{"filePath":"input.txt","edits":[{"oldText":"first","newText":"second"},{"oldText":"second","newText":"$$-$&-$`-$'-$1\n"}]}"""
            )
        );
        Assert.Null(result["error"]);
        Assert.Equal("second $$-$&-$`-$'-$1\n\r\n", await File.ReadAllTextAsync(path));
        result = await Call(
            Args("""{"filePath":"input.txt","oldText":"$","newText":"","replaceAll":true}""")
        );
        Assert.Null(result["error"]);
        Assert.Equal("second -&-`-'-1\n\r\n", await File.ReadAllTextAsync(path));
        result = await Call(
            new JsonObject
            {
                ["apply_patch"] = "*** Begin Patch\n*** Add File: added.txt\n+new\n*** End Patch",
            }
        );
        Assert.Null(result["error"]);
        Assert.Equal("new", await File.ReadAllTextAsync(Path.Combine(temp.Path, "added.txt")));
    }

    [Fact]
    public void Current_catalog_has_only_edit_but_Cli_retains_legacy_patch_wire()
    {
        Assert.DoesNotContain(
            WorkspaceTools.Definitions(),
            tool => tool?["name"]?.GetValue<string>() == "apply_patch"
        );
        var caps = NodeClient.Capabilities();
        Assert.True(caps["features"]!["unifiedEdit"]!.GetValue<bool>());
        Assert.Contains(
            caps["tools"]!.AsArray(),
            tool => tool?["name"]?.GetValue<string>() == "apply_patch"
        );
        Assert.DoesNotContain(
            UnifiedEdit.ProjectTools(caps["tools"]!.AsArray()),
            tool => tool?["name"]?.GetValue<string>() == "apply_patch"
        );
    }
}
