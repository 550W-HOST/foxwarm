using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Tools;
using Xunit;

namespace Foxwarm.Tests.Tools;

public sealed class FileRetryLifetimeTests
{
    [Fact]
    public async Task Failed_retry_retains_ref_until_original_expiry_and_never_writes_after_it()
    {
        var root = Path.Combine(Path.GetTempPath(), "foxwarm-file-retry-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            long now = 1000;
            var cache = new PendingWriteRefs(() => now);
            var tools = new WorkspaceTools(root, cache, "fixture/session", "fixture");
            Task<JsonObject> Write(JsonObject args) => tools.ExecuteAsync(new JsonObject { ["name"] = "write", ["args"] = args }, CancellationToken.None);
            var refused = await Write(new JsonObject { ["filePath"] = "missing/original.txt", ["content"] = "unchanged payload" });
            var id = Regex.Match(refused["error"]!["message"]!.GetValue<string>(), "contentRef: \"(write_[a-f0-9]+)\"").Groups[1].Value;
            Assert.NotEmpty(id);
            now += 14 * 60 * 1000;
            var failed = await Write(new JsonObject { ["filePath"] = "another/destination.txt", ["contentRef"] = id, ["overwrite"] = true });
            Assert.Contains(id, failed["error"]!["message"]!.GetValue<string>());
            Assert.False(Directory.Exists(Path.Combine(root, "another")));
            now += 60 * 1000;
            var expired = await Write(new JsonObject { ["filePath"] = "another/destination.txt", ["contentRef"] = id, ["overwrite"] = true, ["createDirs"] = true });
            Assert.Contains("not found or expired", expired["error"]!["message"]!.GetValue<string>());
            Assert.False(Directory.Exists(Path.Combine(root, "another")));
            Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        }
        finally { Directory.Delete(root, true); }
    }
}
