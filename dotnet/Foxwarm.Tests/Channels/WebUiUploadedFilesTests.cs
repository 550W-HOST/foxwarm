using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class WebUiUploadedFilesTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work");
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal WebUiUploadedFiles Files = null!;
        internal string Staging = "";

        internal static async Task<Fixture> Create(JsonObject? isolation = null)
        {
            var f = new Fixture();
            Console.WriteLine("Owned generic fixture=" + f.Temp.Path);
            try
            {
                if (isolation is not null)
                {
                    Directory.CreateDirectory(Path.Combine(f.Data, "state"));
                    await File.WriteAllTextAsync(
                        Path.Combine(f.Data, "state", "agents.json"),
                        new JsonObject
                        {
                            ["version"] = 2,
                            ["agents"] = new JsonArray(),
                            ["metadata"] = new JsonObject { ["main"] = isolation },
                        }.ToJsonString()
                    );
                }
                var options = new ResponsesClientOptions(
                    new Uri("http://127.0.0.1:1"),
                    "wire",
                    "a",
                    "",
                    "",
                    713
                );
                f.Manager = new(f.Data, f.Work, options, HostModels.ForTest(options));
                await f.Manager.LoadAsync();
                f.Owner = await f.Manager.CreateNamedAsync("main", "source", null, null);
                f.Files = new(f.Manager);
                f.Staging = Path.Combine(f.Files.Root, Guid.NewGuid().ToString("N"));
                return f;
            }
            catch
            {
                if (f.Manager is not null)
                    await f.Manager.DisposeAsync();
                f.Temp.Dispose();
                throw;
            }
        }

        internal async Task<JsonObject> Stage(string name, byte[] bytes, string mime = "")
        {
            Directory.CreateDirectory(Staging);
            var path = Path.Combine(Staging, Guid.NewGuid().ToString("N"));
            await File.WriteAllBytesAsync(path, bytes);
            return new()
            {
                ["path"] = path,
                ["filename"] = name,
                ["mimeType"] = mime,
            };
        }

        internal Task<PreparedUploadedParts> Prepare(params JsonObject[] files) =>
            Files.PrepareAsync(
                new JsonObject
                {
                    ["text"] = "caption",
                    ["uploadedFiles"] = new JsonArray(
                        files.Select(file => (JsonNode)file.DeepClone()).ToArray()
                    ),
                },
                Owner,
                CancellationToken.None
            );

        public async ValueTask DisposeAsync()
        {
            await Manager.DisposeAsync();
            if (Directory.Exists(Staging))
                Directory.Delete(Staging, recursive: true);
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Generic_and_mixed_image_bytes_save_in_actual_Agent_channel_directory_not_cwd_with_truthful_descriptors_and_no_binary_prompt_or_blob()
    {
        await using var f = await Fixture.Create();
        var cwd = Path.Combine(f.Temp.Path, "cwd");
        await f.Owner.UpdateCwdAsync(cwd);
        var bytes = new byte[] { 0, 255, 17, 80, 75 };
        var text = await f.Stage(
            "中文<&\"' file.txt",
            Encoding.UTF8.GetBytes("Actual UTF-8 内容"),
            "text/plain"
        );
        var json = await f.Stage(
            "data.json",
            Encoding.UTF8.GetBytes("{\"actual\":true}"),
            "application/json"
        );
        var pdf = await f.Stage("binary.pdf", bytes, "application/pdf");
        var zip = await f.Stage("archive.zip", bytes, "application/zip");
        var empty = await f.Stage("unnamed.bin", bytes);
        var png = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var image = await f.Stage("image.png", png, "image/png");
        using var admission = f.Manager.BeginFileIngress(f.Owner);
        var result = await f.Prepare(text, json, pdf, zip, empty, image);
        Assert.Equal(6, result.SavedFiles.Count);
        Assert.Equal(1, result.Parts.Count(part => part["inlineDataRef"] is not null));
        foreach (var file in result.SavedFiles)
        {
            var path = file["path"]!.ToString();
            Assert.StartsWith(Path.Combine(f.Work, ".temp", "channel-files", "webui"), path);
            Assert.Equal("master", file["node"]!.ToString());
            Assert.Equal(new FileInfo(path).Length, file["size"]!.GetValue<long>());
        }
        Assert.False(Directory.Exists(cwd));
        Assert.Contains("中文&lt;&amp;&quot;&apos; file.txt", result.Parts[1]["text"]!.ToString());
        Assert.Equal(bytes, await File.ReadAllBytesAsync(result.SavedFiles[2]["path"]!.ToString()));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(result.SavedFiles[3]["path"]!.ToString()));
        Assert.DoesNotContain(
            Convert.ToBase64String(bytes),
            new JsonArray(
                result.Parts.Select(part => (JsonNode)part.DeepClone()).ToArray()
            ).ToJsonString()
        );
        Assert.All(
            new[] { text, json, pdf, zip, empty, image },
            file => Assert.False(File.Exists(file["path"]!.ToString()))
        );
        var imagePart = result.Parts.Single(part => part["inlineDataRef"] is not null);
        Assert.Equal(png, await f.Manager.Images.ReadAsync(imagePart["inlineDataRef"]!.AsObject()));
        Assert.Equal(png, await File.ReadAllBytesAsync(result.SavedFiles[5]["path"]!.ToString()));
    }

    [Theory]
    [InlineData("image.png", "text/plain", false)]
    [InlineData("data.bin", "image/png", true)]
    [InlineData("photo.heic", "", true)]
    [InlineData("document.txt", "", false)]
    [InlineData("notes", "TEXT/PLAIN", false)]
    public void Real_mime_classification_does_not_turn_all_extensions_into_images(
        string name,
        string declared,
        bool image
    )
    {
        Assert.Equal(
            image,
            WebUiUploadedFiles.Mime(declared, name).StartsWith("image/", StringComparison.Ordinal)
        );
        if (declared == "TEXT/PLAIN")
            Assert.Equal(declared, WebUiUploadedFiles.Mime(declared, name));
    }

    [Fact]
    public async Task Bad_staging_outside_symlink_directory_and_oversize_are_explicit_and_do_not_save_or_remove_unrelated_files()
    {
        await using var f = await Fixture.Create();
        Directory.CreateDirectory(f.Staging);
        var outside = Path.Combine(f.Temp.Path, "outside.txt");
        await File.WriteAllTextAsync(outside, "untouched");
        var link = Path.Combine(f.Staging, "escape");
        File.CreateSymbolicLink(link, outside);
        var large = Path.Combine(f.Staging, "large");
        await using (var stream = File.Create(large))
            stream.SetLength(WebUiUploadedFiles.Limit + 1);
        foreach (var path in new[] { outside, link, f.Files.Root, large })
        {
            var error = await Assert.ThrowsAsync<UploadPreparationException>(() =>
                f.Prepare(new JsonObject { ["path"] = path, ["filename"] = "unsafe.bin" })
            );
            Assert.True(error.InvalidInput);
            Assert.Empty(error.SavedFiles);
        }
        Assert.Equal("untouched", await File.ReadAllTextAsync(outside));
        Assert.True(File.Exists(link));
        Assert.False(Directory.Exists(Path.Combine(f.Work, ".temp", "channel-files")));
    }

    [Fact]
    public async Task Multiple_file_failure_reports_actual_saved_subset_and_copy_failure_does_not_claim_rollback_or_delete_unrelated_destination()
    {
        await using var f = await Fixture.Create();
        var first = await f.Stage("first.txt", Encoding.UTF8.GetBytes("saved"), "text/plain");
        var error = await Assert.ThrowsAsync<UploadPreparationException>(() =>
            f.Prepare(first, new JsonObject { ["path"] = Path.Combine(f.Temp.Path, "bad") })
        );
        Assert.Single(error.SavedFiles);
        Assert.Equal("saved", await File.ReadAllTextAsync(error.SavedFiles[0]["path"]!.ToString()));
        Assert.False(File.Exists(first["path"]!.ToString()));
        var next = await f.Stage("next.json", Encoding.UTF8.GetBytes("{}"), "application/json");
        f.Files.BeforeStage = (_, stage) =>
            stage == "after-copy"
                ? Task.FromException(new IOException("Synthetic after-copy"))
                : Task.CompletedTask;
        error = await Assert.ThrowsAsync<UploadPreparationException>(() => f.Prepare(next));
        Assert.Single(error.SavedFiles);
        Assert.True(File.Exists(error.SavedFiles[0]["path"]!.ToString()));
        Assert.True(File.Exists(next["path"]!.ToString()));
        f.Files.BeforeStage = (_, _) =>
            Task.FromException(new IOException("Synthetic before-copy"));
        error = await Assert.ThrowsAsync<UploadPreparationException>(() => f.Prepare(next));
        Assert.Empty(error.SavedFiles);
        f.Files.BeforeStage = (_, stage) =>
            stage == "after-copy"
                ? Task.FromException(
                    new UnauthorizedAccessException("Synthetic local permission loss")
                )
                : Task.CompletedTask;
        error = await Assert.ThrowsAsync<UploadPreparationException>(() => f.Prepare(next));
        Assert.Single(error.SavedFiles);
        Assert.True(File.Exists(error.SavedFiles[0]["path"]!.ToString()));
    }

    [Fact]
    public async Task Before_copy_move_uses_current_Agent_and_after_copy_move_keeps_actual_saved_path_without_rewriting_old_descriptors()
    {
        await using var f = await Fixture.Create();
        var entry = await f.Stage("first.txt", Encoding.UTF8.GetBytes("actual"), "text/plain");
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Files.BeforeStage = (_, stage) =>
        {
            if (stage != "before-copy")
                return Task.CompletedTask;
            reached.TrySetResult();
            return release.Task;
        };
        using var admission = f.Manager.BeginFileIngress(f.Owner);
        var pending = f.Prepare(entry);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await f.Manager.MoveIdentityAsync(
            f.Owner,
            new JsonObject
            {
                ["newSessionId"] = "moved",
                ["newAgentName"] = "other",
                ["createAgent"] = true,
            }
        );
        release.SetResult();
        var prepared = await pending;
        Assert.StartsWith(
            Path.Combine(f.Work, "agents", "other"),
            prepared.SavedFiles[0]["path"]!.ToString()
        );
        reached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Files.BeforeStage = (_, stage) =>
        {
            if (stage != "after-copy")
                return Task.CompletedTask;
            reached.TrySetResult();
            return release.Task;
        };
        entry = await f.Stage("next.txt", Encoding.UTF8.GetBytes("retained"), "text/plain");
        pending = f.Prepare(entry);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await f.Manager.MoveIdentityAsync(
            f.Owner,
            new JsonObject { ["newSessionId"] = "again", ["newAgentName"] = "main" }
        );
        release.SetResult();
        prepared = await pending;
        Assert.StartsWith(
            Path.Combine(f.Work, "agents", "other"),
            prepared.SavedFiles[0]["path"]!.ToString()
        );
        Assert.Contains(
            prepared.SavedFiles[0]["path"]!.ToString(),
            prepared.Parts.Last()["text"]!.ToString()
        );
    }

    [Fact]
    public async Task Accepted_file_preparation_drains_before_retire_and_retired_owner_or_offline_isolated_binding_cannot_save_or_retarget()
    {
        await using var f = await Fixture.Create();
        var staged = await f.Stage("owned.bin", new byte[] { 1, 2 });
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Files.BeforeStage = (_, _) =>
        {
            reached.TrySetResult();
            return release.Task;
        };
        async Task<PreparedUploadedParts> Prepare()
        {
            using var admission = f.Manager.BeginFileIngress(f.Owner);
            return await f.Prepare(staged);
        }
        var pending = Prepare();
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var deletion = f.Manager.DeleteAsync(f.Owner.Id);
        try
        {
            await Task.Delay(30);
            Assert.False(deletion.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        var result = await pending;
        await deletion;
        Assert.Single(result.SavedFiles);
        Assert.True(File.Exists(result.SavedFiles[0]["path"]!.ToString()));
        Assert.ThrowsAny<InvalidOperationException>(() => f.Manager.BeginFileIngress(f.Owner));
        await using var remote = await Fixture.Create(
            new JsonObject { ["isolated"] = true, ["isolatedNode"] = "future" }
        );
        Assert.Throws<InvalidOperationException>(() =>
            remote.Manager.BeginFileIngress(remote.Owner)
        );
        Assert.False(Directory.Exists(Path.Combine(remote.Work, ".temp")));
    }

    [Fact]
    public async Task Actual_Source_inbound_callee_bytes_storage_naming_and_shared_XML_descriptor_differential()
    {
        await using var f = await Fixture.Create();
        var cases = new[]
        {
            ("中文测试<&\"'.txt", "text/plain"),
            ("café.txt", "text/plain"),
            ("无扩展", "application/pdf"),
            ("a.", "application/octet-stream"),
            (".hidden", "application/json"),
            (".. odd\n\"<&'.123456789012345678901234", "application/zip"),
        };
        var input = new JsonArray(
            cases
                .Select(item =>
                    (JsonNode)
                        new JsonObject
                        {
                            ["filename"] = item.Item1,
                            ["mime"] = item.Item2,
                            ["bytes"] = Convert.ToBase64String(
                                Encoding.UTF8.GetBytes("owned bytes")
                            ),
                        }
                )
                .ToArray()
        );
        var inFile = Path.Combine(f.Temp.Path, "input.json");
        var output = Path.Combine(f.Temp.Path, "output.json");
        await File.WriteAllTextAsync(inFile, input.ToJsonString());
        var root = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!;
        var info = new ProcessStartInfo("node")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (
            var arg in new[]
            {
                Path.Combine(root, "dotnet", "channel-files-fixture-ts.mjs"),
                Path.Combine(f.Temp.Path, "source"),
                inFile,
                output,
            }
        )
            info.ArgumentList.Add(arg);
        info.Environment["FOXWARM_TS_ROOT"] = root;
        using var process = Process.Start(info)!;
        var stderr = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await stderr + await stdout);
        var expected = JsonNode.Parse(await File.ReadAllTextAsync(output))!.AsArray();
        for (var i = 0; i < cases.Length; i++)
        {
            var row = expected[i]!.AsObject();
            var name = row["storedName"]!.ToString();
            Assert.True(row["exactBytes"]!.GetValue<bool>());
            Assert.Equal(
                name,
                Foxwarm.Channels.ChannelFileNames.StorageName(
                    cases[i].Item1,
                    cases[i].Item2,
                    name[..24],
                    name.Substring(25, 8)
                )
            );
            Assert.Equal(
                row["descriptor"]!.ToString(),
                Foxwarm.Channels.ChannelFileNames.Descriptor(
                    cases[i].Item1,
                    row["promptPath"]!.ToString(),
                    cases[i].Item2
                )
            );
            Assert.Equal("master", row["nodeId"]!.ToString());
        }
    }
}
