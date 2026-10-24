using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Vector;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

[CollectionDefinition("Vector native", DisableParallelization = true)]
public sealed class VectorNativeCollection;

internal sealed class VectorEmbeddingPeer : IAsyncDisposable
{
    private readonly WebApplication app;
    internal readonly ConcurrentQueue<(string Path, string Model, string Input)> Requests = new();
    internal Func<string, Task>? BeforeResponse { get; set; }
    internal bool Fail { get; set; }
    internal string BaseUrl => app.Urls.Single() + "/v1";

    private VectorEmbeddingPeer(WebApplication app) => this.app = app;

    internal static async Task<VectorEmbeddingPeer> StartAsync()
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        var peer = new VectorEmbeddingPeer(app);
        app.MapPost(
            "/v1/embeddings",
            async (HttpContext context) =>
            {
                var body = (await context.Request.ReadFromJsonAsync<JsonObject>())!;
                var input = body["input"]!.GetValue<string>();
                peer.Requests.Enqueue(
                    (context.Request.Path, body["model"]!.GetValue<string>(), input)
                );
                if (peer.BeforeResponse is not null)
                    await peer.BeforeResponse(input);
                if (peer.Fail)
                    return Results.Json(
                        new { error = new { message = "synthetic embeddings failure" } },
                        statusCode: 503
                    );
                var vector = Embedding(input);
                return Results.Json(new { data = new[] { new { embedding = vector } } });
            }
        );
        await app.StartAsync();
        return peer;
    }

    internal static float[] Embedding(string input)
    {
        var vector = new float[1024];
        vector[0] = 1;
        vector[1] = input.Contains("violet", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
        vector[2] = input.Contains("orange", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
        return vector;
    }

    public async ValueTask DisposeAsync() => await app.DisposeAsync();
}

internal sealed class VectorFixture : IAsyncDisposable
{
    internal readonly TempDirectory Temp = new();
    internal string Data => Path.Combine(Temp.Path, "data");
    internal string Work => Path.Combine(Temp.Path, "work");
    internal string Database => Path.Combine(Data, "state", "archive-store.sqlite");
    internal string Dense => Path.Combine(Data, "state", "db");
    internal VectorEmbeddingPeer Peer { get; private set; } = null!;

    internal VectorConfiguration Configuration(bool child = false, bool lexical = false) =>
        VectorConfiguration.Capture(
            new()
            {
                ["dbWorkers"] = child,
                ["vector"] = new JsonObject
                {
                    ["baseUrl"] = Peer.BaseUrl,
                    ["lexicalIndex"] = lexical,
                    ["hybridSearch"] = lexical,
                },
                ["vectorMaintenance"] = false,
            }
        );

    internal SqliteArchiveMessageStore Archive(string id = "main/fixture") => new(Database, id);

    internal static JsonObject Message(string text, string role = "user") =>
        new() { ["role"] = role, ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    internal void Append(string id, long seq, string text, string role = "user")
    {
        var message = Message(text, role);
        message["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 };
        var archive = Archive(id);
        // Match Session creation and Source writes: current sources have a branch.
        if (archive.ReadBranch() is null)
            archive.EnsureBranch();
        archive.WriteMessages([
            ArchiveMessageRecord.Create(id, id.Split('/')[0], seq, seq * 1000, message),
        ]);
    }

    internal ArchiveBlockRecord Block(
        string id,
        long block = 1,
        long first = 1,
        long last = 1,
        string summary = "violet source block"
    ) =>
        new(
            id,
            id.Split('/')[0],
            block,
            1,
            "message",
            first,
            last,
            null,
            first,
            last,
            null,
            null,
            summary,
            new JsonArray(
                new JsonObject
                {
                    ["kind"] = "decision",
                    ["text"] = "violet stable fact",
                    ["context"] = "synthetic context",
                    ["attributedTo"] = "user",
                }
            ),
            4000
        );

    internal static async Task<VectorFixture> CreateAsync()
    {
        var fixture = new VectorFixture();
        Directory.CreateDirectory(fixture.Work);
        Directory.CreateDirectory(Path.Combine(fixture.Data, "state"));
        fixture.Peer = await VectorEmbeddingPeer.StartAsync();
        fixture.Archive().Initialize();
        return fixture;
    }

    internal async Task<SessionManager> ManagerAsync(
        bool child = false,
        bool lexical = false,
        Uri? modelPeer = null
    )
    {
        var config = new JsonObject
        {
            ["dbWorkers"] = child,
            ["vector"] = new JsonObject
            {
                ["baseUrl"] = Peer.BaseUrl,
                ["lexicalIndex"] = lexical,
                ["hybridSearch"] = lexical,
            },
            ["vectorMaintenance"] = false,
        };
        await File.WriteAllTextAsync(
            Path.Combine(Data, "state", "config.yaml"),
            config.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(Data, "state", "models.yaml"),
            new JsonObject
            {
                ["default"] = "fixture",
                ["providers"] = new JsonObject
                {
                    ["fixture"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = (modelPeer ?? new Uri("http://127.0.0.1:1")).ToString(),
                        ["token"] = "synthetic-local",
                        ["context"] = 200000,
                        ["maxOutput"] = 20000,
                    },
                },
            }.ToJsonString()
        );
        var configuration = new ModelConfiguration(Data);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "synthetic",
            "fixture",
            "",
            "",
            1000
        );
        var manager = new SessionManager(
            Data,
            Work,
            options,
            configuration.Models,
            Path.Combine(Temp.Path, "skills")
        );
        await manager.LoadAsync();
        return manager;
    }

    public async ValueTask DisposeAsync()
    {
        await Peer.DisposeAsync();
        Temp.Dispose();
    }

    internal static string Repository()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "dotnet", "Foxwarm.sln")))
                return directory.FullName;
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("Repository root is unavailable.");
    }

    internal static async Task<JsonNode> SourceAsync(
        string mode,
        string root,
        string input,
        string output
    )
    {
        var repository = Repository();
        var source =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException(
                "Set FOXWARM_TS_ROOT to the frozen, built Source checkout."
            );
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = source,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (
            var arg in new[]
            {
                Path.Combine(repository, "dotnet", "vector-fixture-source.mjs"),
                mode,
                root,
                input,
                output,
            }
        )
            start.ArgumentList.Add(arg);
        start.Environment["FOXWARM_DATA_DIR"] = root;
        start.Environment["FOXWARM_TS_ROOT"] = source;
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(40));
        Assert.True(process.ExitCode == 0, await stderr + "\n" + await stdout);
        return JsonNode.Parse(await File.ReadAllTextAsync(output))!;
    }
}
