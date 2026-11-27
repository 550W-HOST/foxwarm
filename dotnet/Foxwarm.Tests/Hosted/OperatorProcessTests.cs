using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Operator;
using Foxwarm.Secrets;
using Xunit;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
public sealed class OperatorProcessTests
{
    private static int FreePort()
    {
        using var socket = new TcpListener(IPAddress.Loopback, 0);
        socket.Start();
        return ((IPEndPoint)socket.LocalEndpoint).Port;
    }

    private sealed record Reply(HttpStatusCode Status, string Text)
    {
        internal JsonNode Json => JsonNode.Parse(Text)!;
    }

    private static async Task<Reply> Send(HttpClient client, HttpMethod method, string uri, string? host = null, string? bearer = null, JsonNode? body = null, string? cookie = null)
    {
        using var request = new HttpRequestMessage(method, uri);
        request.Headers.Host = host;
        if (bearer is not null) request.Headers.Authorization = new("Bearer", bearer);
        if (cookie is not null) request.Headers.Add("Cookie", cookie);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request);
        return new(response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    private static async Task Until(Func<Task<bool>> check)
    {
        var time = Stopwatch.StartNew();
        while (!await check())
        {
            Assert.True(time.Elapsed < TimeSpan.FromSeconds(35), "The expected owner state was not observed.");
            await Task.Delay(100);
        }
    }

    [Fact]
    public async Task OperatorProvisionsAndRotatesThroughTheCliAndTheReplicaExchangesOnce()
    {
        await using var harness = await ReplicaProcessHarness.CreateAsync();
        var db = harness.Database;
        using var root = new TempDirectory();
        var key = Path.Combine(root.Path, "kek.json");
        InstanceKeys.OpenOrCreate(key);
        var port = FreePort();
        var origin = $"http://127.0.0.1:{port}";
        var config = Path.Combine(root.Path, "deployment.yaml");
        await File.WriteAllTextAsync(config, $"url: 'https://{{slug}}.test'\nbot: {{httpHost: 127.0.0.1}}\nhealth: {{port: 3002}}\nblobs: {{backend: postgres}}\noperator: {{port: {port}, url: '{origin}'}}\n");
        Process Launch(string url, params string[] args)
        {
            var info = new ProcessStartInfo(Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT")!, "dotnet"))
            { WorkingDirectory = root.Path, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var name in info.Environment.Keys.Where(k => k.StartsWith("FOXWARM_")).ToArray()) info.Environment.Remove(name);
            info.Environment["FOXWARM_DATABASE_URL"] = url;
            info.Environment["FOXWARM_MIGRATE_DATABASE_URL"] = db.OwnerConnectionString;
            info.Environment["FOXWARM_DEPLOYMENT_CONFIG"] = config;
            info.Environment["FOXWARM_KEK_FILE"] = key;
            info.Environment["FOXWARM_DATA_DIR"] = root.Path;
            info.Environment["DOTNET_GCHeapHardLimit"] = "0x20000000";
            info.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "Foxwarm.dll"));
            info.ArgumentList.Add("operator");
            foreach (var arg in args) info.ArgumentList.Add(arg);
            return Process.Start(info)!;
        }
        async Task<string> Cli(params string[] args)
        {
            using var command = Launch(db.OperatorConnectionString, args);
            var output = command.StandardOutput.ReadToEndAsync();
            var error = command.StandardError.ReadToEndAsync();
            await command.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(25));
            Assert.True(command.ExitCode == 0, await error);
            return (await output).Trim();
        }
        var op = await Cli("token", "create");
        var tokenFile = Path.Combine(root.Path, "operator-token");
        await File.WriteAllTextAsync(tokenFile, op);
        Assert.NotEqual(op, (string?)await db.ScalarAsync("SELECT hash FROM operator_credentials"));
        using (var wrongRole = Launch(db.OwnerConnectionString, "serve"))
        {
            await wrongRole.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal(78, wrongRole.ExitCode);
        }
        using var service = Launch(db.OperatorConnectionString, "serve");
        var serviceError = service.StandardError.ReadToEndAsync();
        _ = service.StandardOutput.ReadToEndAsync();
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false, UseCookies = false });
        var api = origin + OperatorServer.Path;
        Task<Reply> Call(HttpMethod method, string path, JsonNode? body = null) => Send(client, method, api + path, bearer: op, body: body);
        try
        {
            await Until(async () =>
            {
                Assert.False(service.HasExited, service.HasExited ? await serviceError : "");
                try { return (await Call(HttpMethod.Get, "/tenants")).Status == HttpStatusCode.OK; }
                catch (HttpRequestException) { return false; }
            });
            Assert.Equal(HttpStatusCode.Unauthorized, (await Send(client, HttpMethod.Get, api + "/tenants", cookie: "foxwarm_token=" + op)).Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Send(client, HttpMethod.Get, api + "/tenants", bearer: "fwop_" + new string('0', 64))).Status);
            Assert.Equal(HttpStatusCode.NotFound, (await Send(client, HttpMethod.Get, api + "/tenants", "alpha.test", op)).Status);
            Assert.Equal(HttpStatusCode.NotFound, (await Send(client, HttpMethod.Post, origin + "/api/auth", bearer: op)).Status);
            var unknown = await Send(client,HttpMethod.Get,api+"/unknown");
            Assert.Equal(HttpStatusCode.NotFound,unknown.Status); Assert.Equal("",unknown.Text);
            using (var foreign = new HttpRequestMessage(HttpMethod.Get,api+"/tenants"))
            {
                foreign.Headers.Authorization=new("Bearer",op);
                foreign.Headers.Add("Origin","https://another.test");
                using var refused=await client.SendAsync(foreign);
                Assert.Equal(HttpStatusCode.Forbidden,refused.StatusCode);
            }
            var create = new JsonObject { ["slug"] = "alpha", ["profile"] = "hosted", ["primaryHostname"] = "custom.test" };
            Assert.Equal(HttpStatusCode.BadRequest, (await Call(HttpMethod.Post, "/tenants", create)).Status);
            var created = JsonNode.Parse(await Cli("--url", origin, "--token-file", tokenFile, "tenant", "create", "alpha", "hosted", "alpha.test"))!;
            var setup = (string)created["setupToken"]!;
            Assert.Matches("^[0-9]+-[0-9]{8}T[0-9:.]+Z$", (string)(await db.ScalarAsync("SELECT object_identity FROM tenants WHERE name='alpha'"))!);
            var legacyOutput = new StringWriter();
            Assert.Equal(78, await Foxwarm.Hosted.HostedCli.RunAsync(["hosted", "token", "--tenant", "alpha"], legacyOutput, new StringWriter(),
                new System.Collections.Hashtable { ["FOXWARM_DATABASE_URL"] = db.AppConnectionString, ["FOXWARM_KEK_FILE"] = key }));
            Assert.Empty(legacyOutput.ToString());
            create["primaryHostname"] = "alpha.test";
            Assert.Equal(HttpStatusCode.Conflict, (await Call(HttpMethod.Post, "/tenants", create)).Status);
            Assert.Equal("alpha.test", (string?)(await Call(HttpMethod.Get, "/tenants/alpha")).Json["primaryHostname"]);
            Assert.Contains((await Call(HttpMethod.Get, "/tenants")).Json.AsArray(), row => (string?)row?["slug"] == "alpha");
            Assert.Equal(1L, await db.ScalarAsync("SELECT count(*) FROM tenant_keys JOIN tenants USING(tenant_id) WHERE name='alpha'"));
            Assert.Equal(0L, await db.ScalarAsync("SELECT count(*) FROM config_documents JOIN tenants t USING(tenant_id) WHERE t.name='alpha'"));
            Assert.Equal(HttpStatusCode.NotFound, (await Call(HttpMethod.Get, "/tenants/missing")).Status);
            Assert.Equal(HttpStatusCode.BadRequest, (await Call(HttpMethod.Patch, "/tenants/alpha", new JsonObject { ["limits"] = new JsonObject { ["requestBurst"] = 0 } })).Status);
            var ceiling = new JsonObject { ["ceiling"] = "version: 1\nrules: []\n" };
            Assert.Equal(HttpStatusCode.OK, (await Call(HttpMethod.Put, "/profiles/hosted/ceiling", ceiling)).Status);
            Assert.Equal((string?)ceiling["ceiling"], (string?)(await Call(HttpMethod.Get, "/profiles/hosted/ceiling")).Json["ceiling"]);
            var edits = new JsonObject { ["primaryHostname"] = "alpha.test", ["ceiling"] = ceiling["ceiling"]!.DeepClone(), ["profile"] = "operator" };
            Assert.Equal(HttpStatusCode.OK, (await Call(HttpMethod.Patch, "/tenants/alpha", edits)).Status);
            Assert.Equal("operator", (string?)(await Call(HttpMethod.Get, "/tenants/alpha")).Json["profile"]);
            edits["profile"] = "hosted";
            Assert.Equal(HttpStatusCode.OK, (await Call(HttpMethod.Patch, "/tenants/alpha", edits)).Status);
            var replica = await harness.StartAsync("general", new Dictionary<string,string> { ["FOXWARM_KEK_FILE"] = key });
            var front = $"http://127.0.0.1:{replica.FrontPort}";
            Task<Reply> Redeem(string value) => Send(client, HttpMethod.Post, front + "/api/auth", "alpha.test", body: new JsonObject { ["token"] = value });
            Task<Reply> AsAdmin(string value, string path) => Send(client, HttpMethod.Get, front + path, "alpha.test", value);
            var exchanges = await Task.WhenAll(Redeem(setup), Redeem(setup));
            Assert.Equal("setup_used", (string?)exchanges.Single(x => x.Status == HttpStatusCode.Unauthorized).Json["code"]);
            var reusable = (string)exchanges.Single(x => x.Status == HttpStatusCode.OK).Json["instanceToken"]!;
            Assert.Equal(HttpStatusCode.OK, (await AsAdmin(reusable, "/api/auth/session")).Status);
            Assert.Equal(HttpStatusCode.NotFound, (await AsAdmin(reusable, OperatorServer.Path + "/tenants")).Status);
            Assert.Equal(HttpStatusCode.Unauthorized, (await AsAdmin(op, "/api/auth/session")).Status);
            await Until(async () => (await Call(HttpMethod.Get, "/placement")).Json["tenants"]!.AsArray().Any(x => (string?)x?["slug"] == "alpha" && x["hot"] != null));
            var place = (await Call(HttpMethod.Get, "/placement")).Json;
            Assert.Equal("general", (string?)place["replicas"]![0]!["role"]);
            Assert.NotNull(place["replicas"]![0]!["version"]);
            // No last-owner sample is attributed to a different epoch.
            await db.ExecuteOwnerAsync("UPDATE replicas SET capacity=jsonb_set(capacity, '{tenants,alpha,epoch}', '-1')");
            Assert.Null((await Call(HttpMethod.Get, "/placement")).Json["tenants"]!.AsArray().Single(t => (string?)t!["slug"] == "alpha")!["hot"]);
            var epoch = await harness.EpochAsync("alpha");
            var changed = new JsonObject { ["limits"] = new JsonObject { ["requestsPerSecond"] = 1, ["requestBurst"] = 1, ["dbStatements"] = 2, ["agentStoreFiles"] = 200 }, ["journal"] = new JsonObject { ["enabled"] = false, ["retentionDays"] = 2 } };
            Assert.Equal(HttpStatusCode.OK, (await Call(HttpMethod.Patch, "/tenants/alpha", changed)).Status);
            await Until(async () => { await AsAdmin(reusable, "/health"); return await harness.EpochAsync("alpha") > epoch; });
            Assert.Contains(HttpStatusCode.TooManyRequests, new[] { (await AsAdmin(reusable,"/health")).Status, (await AsAdmin(reusable,"/health")).Status });
            var reserved = await AsAdmin(reusable,OperatorServer.Path+"/placement");
            Assert.Equal(HttpStatusCode.NotFound,reserved.Status); Assert.Equal("",reserved.Text);
            var reset = await Call(HttpMethod.Patch, "/tenants/alpha", new JsonObject { ["limits"] = new JsonObject() });
            Assert.Equal(HttpStatusCode.OK, reset.Status);
            await Until(async () => (await AsAdmin(reusable,"/health")).Status == HttpStatusCode.OK && await harness.EpochAsync("alpha") > epoch + 1);
            var session = await Send(client, HttpMethod.Post, front + "/api/sessions", "alpha.test", reusable,
                new JsonObject { ["agentId"] = "main", ["sessionId"] = "rotation" });
            Assert.True((int)session.Status < 300, session.Text);
            using var eventsRequest = new HttpRequestMessage(HttpMethod.Get, front + "/api/sessions/rotation/stream");
            eventsRequest.Headers.Host = "alpha.test";
            eventsRequest.Headers.Authorization = new("Bearer", reusable);
            using var events = await client.SendAsync(eventsRequest, HttpCompletionOption.ResponseHeadersRead);
            Assert.Equal("text/event-stream", events.Content.Headers.ContentType?.MediaType);
            using var socket = new ClientWebSocket();
            socket.Options.SetRequestHeader("Host", "alpha.test");
            socket.Options.SetRequestHeader("Authorization", "Bearer " + reusable);
            await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{replica.FrontPort}/api/webui/stream"), CancellationToken.None);
            var rotation = await Call(HttpMethod.Post, "/tenants/alpha/rotate");
            Assert.Equal(HttpStatusCode.OK, rotation.Status);
            var nextSetup = (string)rotation.Json["setupToken"]!;
            using var bound = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            try
            {
                while ((await socket.ReceiveAsync(new ArraySegment<byte>(new byte[4096]), bound.Token)).MessageType != WebSocketMessageType.Close) { }
            }
            catch (WebSocketException) { }
            await using var stream = await events.Content.ReadAsStreamAsync();
            try
            {
                while (await stream.ReadAsync(new byte[4096], bound.Token) != 0) { }
            }
            catch (IOException) { }
            await Until(async () => (await AsAdmin(reusable, "/api/auth/session")).Status == HttpStatusCode.Unauthorized);
            var next = await Redeem(nextSetup);
            Assert.Equal(HttpStatusCode.OK, next.Status);
            Assert.NotEqual(reusable, (string?)next.Json["instanceToken"]);
            Assert.Equal(HttpStatusCode.Unauthorized, (await Redeem(nextSetup)).Status);
            nextSetup = (string)(await Call(HttpMethod.Post, "/tenants/alpha/rotate")).Json["setupToken"]!;
            await db.ExecuteOwnerAsync("UPDATE tenant_auth SET expires_at=now()-interval '1 second' WHERE tenant_id=(SELECT tenant_id FROM tenants WHERE name='alpha')");
            await Until(async () =>
            {
                var reply = await Redeem(nextSetup);
                return reply.Status == HttpStatusCode.Unauthorized && (string?)reply.Json["code"] == "setup_expired";
            });
        }
        finally
        {
            if (!service.HasExited) service.Kill(true);
            await service.WaitForExitAsync();
        }
    }
}
