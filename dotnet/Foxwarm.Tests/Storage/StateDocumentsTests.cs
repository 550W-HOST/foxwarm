using System.Text.Json.Nodes;
using Foxwarm.Storage;

namespace Foxwarm.Tests;

public sealed class StateDocumentsTests
{
    [Fact]
    public async Task Every_document_reads_absent_then_returns_the_replaced_text()
    {
        using var temp = new TempDirectory();
        var documents = new FileStateDocuments(temp.Path);
        foreach (var name in Enum.GetValues<StateDocumentName>())
        {
            var document = documents.Open(name);
            Assert.Null(document.ReadText());
            Assert.Null(await document.ReadTextAsync());
            Assert.Null(document.ReadFirstAvailable(text => text, out var source));
            Assert.Null(source);
            var text = "{\"name\":\"" + name + "\"}";
            document.ReplaceText(text);
            Assert.Equal(text, documents.Open(name).ReadText());
            Assert.StartsWith(Path.Combine(temp.Path, "state"), document.Locator);
        }
    }

    [Fact]
    public void Private_documents_keep_owner_only_mode()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var documents = new FileStateDocuments(temp.Path);
        foreach (var name in new[] { StateDocumentName.Nodes, StateDocumentName.McpOAuth })
        {
            var document = documents.Open(name);
            document.ReplaceText("{}");
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(document.Locator)
            );
        }
    }

    [Fact]
    public void Timers_absence_requires_a_directory_parent()
    {
        using var temp = new TempDirectory();
        File.WriteAllText(Path.Combine(temp.Path, "state"), "not a directory");
        var documents = new FileStateDocuments(temp.Path);
        var error = Assert.Throws<IOException>(() =>
            documents.Open(StateDocumentName.Timers).ReadText()
        );
        Assert.Equal("Timer store parent is unavailable.", error.Message);
        // The OAuth grants keep their existence check and read as absent.
        Assert.Null(documents.Open(StateDocumentName.McpOAuth).ReadText());
    }

    [Fact]
    public void Node_registry_falls_back_to_a_retained_version()
    {
        using var temp = new TempDirectory();
        var document = new FileStateDocuments(temp.Path).Open(StateDocumentName.Nodes);
        document.ReplaceText("{\"version\":1}");
        document.ReplaceText("{\"version\":2}");
        File.WriteAllText(document.Locator, "{broken");
        var value = document.ReadFirstAvailable(
            text => JsonNode.Parse(text)!.AsObject(),
            out var source
        );
        Assert.Equal(1, (int)value!["version"]!);
        Assert.NotEqual(document.Locator, source);
    }
}
