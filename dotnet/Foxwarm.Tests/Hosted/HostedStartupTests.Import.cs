using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Xunit;

namespace Foxwarm.Tests.Hosted;

// A replica started on a tenant `foxwarm hosted import` filled (p1-plan §9): the production
// runtime over the imported configuration documents, key ring and credentials.
public sealed partial class HostedStartupTests
{
    [Fact]
    public async Task AReplicaStartedOnAnImportedTenantListsItsSessionsAndOpensOne()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var fixture = await ImportFixture.BuildAsync(Path.Combine(temp.Path, "fixture"));
        var files = HostedFiles.Create(temp.Path);
        var kek = KeyEncryptionKey.From(InstanceKeys.Read(files.Kek));
        var imported = await HostedImportTests.RunAsync(
            database,
            fixture.DataRoot,
            PostgresServer.Tenant,
            Directory.CreateDirectory(Path.Combine(temp.Path, "reports")).FullName,
            kek: kek
        );
        Assert.True(imported.Exit == 0, imported.Report.ToJsonString());
        IStorageContext? storage = null;
        // The Agent folders reach the tenant's Agent store before the runtime starts.
        var replica = StartHosted(
            database.OpenApp(),
            files,
            built =>
            {
                storage = built;
                CopyAgentsToStoreAsync(Path.Combine(fixture.DataRoot, "agents"), built.AgentFiles!).GetAwaiter().GetResult();
            }
        );
        await WaitUntilAsync(
            () => replica.Inner.Health.Role == ReplicaRole.Owner && replica.Inner.Health.RuntimeStarted,
            TimeSpan.FromSeconds(60),
            "the replica serves the imported tenant"
        );
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{replica.PublicPort}"),
            Timeout = TimeSpan.FromSeconds(20),
        };
        // The source's HTTP token was imported as the tenant's credential.
        var token = await File.ReadAllTextAsync(Path.Combine(fixture.DataRoot, "state", "token"));
        Assert.Equal(token.Trim(), storage!.Credentials.Read(InstanceCredentialName.HttpToken)!.Trim());
        client.DefaultRequestHeaders.Authorization = new("Bearer", token.Trim());

        var listed = (await client.GetFromJsonAsync<JsonObject>("api/sessions"))!.ToJsonString();
        Assert.Contains(fixture.SessionId, listed);
        Assert.Contains(fixture.ChildSessionId, listed);
        var history = await client.GetAsync("api/sessions/" + Uri.EscapeDataString(fixture.SessionId) + "/history");
        var body = await history.Content.ReadAsStringAsync();
        Assert.True(history.IsSuccessStatusCode, body);
        Assert.Contains("Hello from the file installation.", body);
        Assert.Contains("Imported reply.", body);

        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
    }

    // Each Agent folder as one Agent of the store, the installation's files beside them at
    // the installation level; links are left out.
    internal static async Task CopyAgentsToStoreAsync(string agents, IAgentStore store)
    {
        foreach (var file in Directory.EnumerateFiles(agents))
            await store.WriteAsync(null, Path.GetFileName(file), await File.ReadAllBytesAsync(file), null, default);
        foreach (var folder in Directory.EnumerateDirectories(agents).Where(path => !Path.GetFileName(path).StartsWith('.')))
        {
            string Relative(string path) => Path.GetRelativePath(folder, path).Replace(Path.DirectorySeparatorChar, '/');
            var entries = new DirectoryInfo(folder)
                .EnumerateFileSystemInfos("*", SearchOption.AllDirectories)
                .Where(entry => entry.LinkTarget is null)
                .ToArray();
            var files = new List<KeyValuePair<string, byte[]>>();
            foreach (var file in entries.OfType<FileInfo>())
                files.Add(new(Relative(file.FullName), await File.ReadAllBytesAsync(file.FullName)));
            var directories = entries
                .OfType<DirectoryInfo>()
                .Where(directory => !directory.EnumerateFileSystemInfos().Any())
                .Select(directory => Relative(directory.FullName))
                .ToArray();
            await store.CreateAgentAsync(Path.GetFileName(folder), directories, files, default);
        }
    }
}
