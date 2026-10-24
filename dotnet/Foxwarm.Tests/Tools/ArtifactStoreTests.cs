using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Artifacts;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class ArtifactStoreTests
{
    internal static JsonObject Chart(string title = "Snapshot") =>
        new()
        {
            ["type"] = "chart",
            ["schemaVersion"] = 1,
            ["title"] = title,
            ["data"] = new JsonArray(new JsonObject { ["step"] = 1, ["value"] = 2 }),
            ["spec"] = new JsonObject
            {
                ["mark"] = "line",
                ["encoding"] = new JsonObject
                {
                    ["x"] = new JsonObject { ["field"] = "step", ["type"] = "quantitative" },
                    ["y"] = new JsonObject { ["field"] = "value", ["type"] = "quantitative" },
                },
            },
        };

    internal static JsonObject React(
        string source = "export default function App(){return <output>Shared compiler</output>}"
    ) =>
        new()
        {
            ["type"] = "react",
            ["schemaVersion"] = 1,
            ["title"] = "React snapshot",
            ["entry"] = "App.tsx",
            ["files"] = new JsonObject { ["App.tsx"] = source },
        };

    internal static async Task<JsonObject> Source(JsonObject request)
    {
        var root =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException(
                "FOXWARM_TS_ROOT is required for Source records"
            );
        var info = new ProcessStartInfo("node")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add(
            Path.Combine(root, "dotnet", "Foxwarm.Tests", "Fixtures", "artifact-fixture-ts.mjs")
        );
        using var child = Process.Start(info)!;
        await child.StandardInput.WriteAsync(request.ToJsonString());
        child.StandardInput.Close();
        var output = child.StandardOutput.ReadToEndAsync();
        var errors = child.StandardError.ReadToEndAsync();
        await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(child.ExitCode == 0, await errors);
        return JsonNode.Parse(await output)!.AsObject();
    }

    [Fact]
    public async Task Original_Source_records_and_resources_support_managed_updates_and_Source_reads_of_both_revisions()
    {
        using var temp = new TempDirectory();
        var store = new ArtifactStore(temp.Path);
        var image = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var source = await Source(
            new JsonObject
            {
                ["root"] = temp.Path,
                ["action"] = "publish",
                ["sessionId"] = "owner",
                ["image"] = Convert.ToBase64String(image),
            }
        );
        var id = SessionWait.Text(source["receipt"]?["artifactId"])!;
        Assert.True(JsonNode.DeepEquals(source, await store.ReadAsync(id, 1, "owner")));
        Assert.Equal(image, (await store.ResourceAsync(id, 1, "owner", "image")).Bytes);
        var changed = ImageCodecTests.Raster(SKEncodedImageFormat.Jpeg);
        var document = await new ArtifactPreparer().ImageAsync(
            changed,
            "Managed image",
            null,
            default
        );
        await store.PublishAsync("owner", document, id, 1, changed);
        var original = await Source(
            new JsonObject
            {
                ["root"] = temp.Path,
                ["action"] = "read",
                ["sessionId"] = "owner",
                ["artifactId"] = id,
                ["revision"] = 1,
            }
        );
        var updated = await Source(
            new JsonObject
            {
                ["root"] = temp.Path,
                ["action"] = "read",
                ["sessionId"] = "owner",
                ["artifactId"] = id,
                ["revision"] = 2,
            }
        );
        Assert.Equal(image, Convert.FromBase64String(SessionWait.Text(original["resource"])!));
        Assert.Equal(changed, Convert.FromBase64String(SessionWait.Text(updated["resource"])!));
        Assert.True(JsonNode.DeepEquals(await store.ReadAsync(id, 2, "owner"), updated["record"]));
        var digest = SessionWait.Text(source["resources"]?["image"]?["sha256"])!;
        await File.WriteAllBytesAsync(Path.Combine(temp.Path, id, "resources", digest), [1, 2, 3]);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            store.ResourceAsync(id, 1, "owner", "image")
        );
    }

    [Fact]
    public async Task Pinned_ownership_type_and_concurrent_revision_conflicts_match_immutable_Source_layout()
    {
        using var temp = new TempDirectory();
        var store = new ArtifactStore(temp.Path);
        var first = await Source(
            new JsonObject
            {
                ["root"] = temp.Path,
                ["action"] = "publish",
                ["sessionId"] = "owner",
                ["document"] = Chart("Original"),
            }
        );
        var id = SessionWait.Text(first["receipt"]?["artifactId"])!;
        await Assert.ThrowsAsync<InvalidDataException>(() => store.ReadAsync(id, 1, "other"));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            store.PublishAsync("other", Chart(), id, 1)
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            store.PublishAsync("owner", React(), id, 1)
        );
        async Task<bool> Update()
        {
            try
            {
                await store.PublishAsync("owner", Chart("Changed"), id, 1);
                return true;
            }
            catch (InvalidDataException)
            {
                return false;
            }
        }
        Assert.Single(await Task.WhenAll(Update(), Update()), result => result);
        Assert.Equal(
            "Original",
            SessionWait.Text((await store.ReadAsync(id, 1, "owner"))["document"]?["title"])
        );
        Assert.Equal(2, await store.LatestRevisionAsync(id, "owner"));
        Assert.Equal(
            "Changed",
            SessionWait.Text((await store.ReadAsync(id, 2, "owner"))["document"]?["title"])
        );
        Assert.Equal(2, Directory.GetFiles(Path.Combine(temp.Path, id)).Length);
        File.Delete(Path.Combine(temp.Path, id, "1.json"));
        await Assert.ThrowsAsync<FileNotFoundException>(() => store.ReadAsync(id, 1, "owner"));
        await Assert.ThrowsAsync<FileNotFoundException>(() =>
            store.LatestRevisionAsync(id, "owner")
        );
        Assert.Equal(
            2,
            SessionWait.Number((await store.ReadAsync(id, 2, "owner"))["receipt"]?["revision"])
        );
    }

    [Fact]
    public async Task Actual_shared_compiler_resolves_local_files_and_fixed_React_without_evaluating_authored_code()
    {
        using var temp = new TempDirectory();
        var store = new ArtifactStore(temp.Path);
        var document = React(
            "import React from 'react'; import { value } from './local'; import './style.css'; throw new Error('Never execute'); export default function App(){return <output>{React.version}:{value}</output>}"
        );
        document["files"]!["local.ts"] = "export const value = 'local data'";
        document["files"]!["style.css"] = "output{color:var(--text)}";
        var record = await store.PublishAsync("owner", document);
        Assert.Contains("18.3.1", SessionWait.Text(record["compiled"])!);
        Assert.Contains("local data", SessionWait.Text(record["compiled"])!);
        foreach (
            var specifier in new[]
            {
                "node:fs",
                "https://invalid.example/module.js",
                "../../private",
                "child_process",
            }
        )
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                store.PublishAsync(
                    "owner",
                    React($"import value from '{specifier}'; export default () => value")
                )
            );
        var badChart = Chart();
        badChart["spec"]!["transform"] = new JsonArray(
            new JsonObject { ["calculate"] = "alert(1)" }
        );
        await Assert.ThrowsAsync<InvalidDataException>(() => store.PublishAsync("owner", badChart));
    }

    [Fact]
    public async Task Real_GIF_animation_retains_original_bytes_and_rejects_the_original_frame_bound()
    {
        using var temp = new TempDirectory();
        var generated = await Source(
            new JsonObject { ["root"] = temp.Path, ["action"] = "animated" }
        );
        var allowed = Convert.FromBase64String(SessionWait.Text(generated["images"]![0])!);
        var oversized = Convert.FromBase64String(SessionWait.Text(generated["images"]![1])!);
        var prepare = new ArtifactPreparer();
        var document = await prepare.ImageAsync(allowed, "Animation", null, default);
        Assert.Equal("image/gif", SessionWait.Text(document["mimeType"]));
        Assert.Equal(8, SessionWait.Number(document["height"]));
        var store = new ArtifactStore(temp.Path);
        var record = await store.PublishAsync("owner", document, image: allowed);
        Assert.Equal(
            allowed,
            (
                await store.ResourceAsync(
                    SessionWait.Text(record["receipt"]?["artifactId"])!,
                    1,
                    "owner",
                    "image"
                )
            ).Bytes
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            prepare.ImageAsync(oversized, "Too many frames", null, default)
        );
    }

    [Fact]
    public async Task Raster_preparation_rejects_executable_formats_and_mismatched_dimensions_without_model_optimization()
    {
        using var temp = new TempDirectory();
        var prepare = new ArtifactPreparer();
        foreach (
            var format in new[]
            {
                SKEncodedImageFormat.Png,
                SKEncodedImageFormat.Jpeg,
                SKEncodedImageFormat.Webp,
            }
        )
        {
            var bytes = ImageCodecTests.Raster(format);
            var document = await prepare.ImageAsync(
                bytes,
                "Original",
                JsonValue.Create("Accessible"),
                default
            );
            var store = new ArtifactStore(temp.Path);
            var record = await store.PublishAsync("owner", document, image: bytes);
            Assert.Equal(
                bytes,
                (
                    await store.ResourceAsync(
                        SessionWait.Text(record["receipt"]?["artifactId"])!,
                        1,
                        "owner",
                        "image"
                    )
                ).Bytes
            );
            document["width"] = document["width"]!.GetValue<int>() + 1;
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                store.PublishAsync("owner", document, image: bytes)
            );
        }
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            prepare.ImageAsync(
                "<svg><script>unsafe</script></svg>"u8.ToArray(),
                "Unsafe",
                null,
                default
            )
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            prepare.ImageAsync(new byte[ArtifactStore.ImageLimit + 1], "Oversized", null, default)
        );
    }
}
