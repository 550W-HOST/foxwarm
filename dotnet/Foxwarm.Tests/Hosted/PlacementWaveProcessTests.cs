using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Lease;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

[Trait("Backend", "postgres")]
[Collection("Process console")]
public sealed class PlacementWaveProcessTests(ITestOutputHelper output)
{
    private static readonly string[] Names = ["replica-a", "replica-b", "replica-c"];
    private const string Egress = "egress: {allow: {hosted: [127.0.0.1]}}";

    // Deliberately put twelve independent tenants on a single boot, above the eight
    // concurrent control writes. The other eight start on the other two replicas.
    private static string[] Slugs() => Names.SelectMany((name, index) => Enumerable.Range(0, 500)
        .Select(i => $"wave-{i}").Where(s => Names.MaxBy(n => Placement.Score(s,n)) == name)
        .Take(index == 0 ? 12 : 4)).ToArray();

    private static async Task UntilAsync(Func<Task<bool>> condition, string description, int seconds = 75)
    {
        var watch = Stopwatch.StartNew();
        while (!await condition())
        {
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(seconds), "Timed out: " + description);
            await Task.Delay(150);
        }
    }

    private static async Task<ReplicaProcessHarness.Replica[]> StartAsync(ReplicaProcessHarness cluster, string[] slugs)
    {
        foreach (var slug in slugs) await cluster.AddTenantAsync(slug);
        var boots = new List<ReplicaProcessHarness.Replica>();
        foreach (var name in Names) boots.Add(await cluster.StartAsync(name, extraConfig: Egress));
        foreach (var slug in slugs)
        {
            using var response = await boots[1].GetAsync(slug);
            Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.Equal(Names.MaxBy(n => Placement.Score(slug,n)), ReplicaRegistry.LogicalName((await cluster.OwnerAsync(slug))!));
        }
        return boots.ToArray();
    }

    private static async Task<Dictionary<string,string>> TokensAsync(ReplicaProcessHarness cluster, string[] slugs)
    {
        var tokens = new Dictionary<string,string>();
        foreach (var slug in slugs) tokens.Add(slug, await cluster.SignInTokenAsync(slug));
        return tokens;
    }

    private static async Task ReadAsync(HttpClient client, ReplicaProcessHarness.Replica edge, string slug, string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{edge.FrontPort}/api/sessions");
        request.Headers.Host = slug + ".test";
        request.Headers.Authorization = new("Bearer", token);
        using var response = await client.SendAsync(request);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{slug} through {edge.Name}: {(int)response.StatusCode}");
    }

    private static async Task<Dictionary<string, ReplicaProcessHarness.LeaseRow>> RowsAsync(ReplicaProcessHarness cluster, string[] slugs)
    {
        var rows = new Dictionary<string, ReplicaProcessHarness.LeaseRow>();
        foreach (var slug in slugs) rows[slug] = await cluster.LeaseRowAsync(slug);
        return rows;
    }

    [Fact]
    public async Task DisagreeingRanksAndDuplicateNamesStillProduceOneLiveOwner()
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        var names = Names;
        var slugs = Enumerable.Range(0, 200).Select(i => "rank-" + i)
            .Where(s => Placement.Rank(s, names)[0] == names[0]).Take(3).ToArray();
        foreach (var slug in slugs) await cluster.AddTenantAsync(slug);
        var top = await cluster.StartAsync(names[0]);
        var left = await cluster.StartAsync(names[1]);
        var right = await cluster.StartAsync(names[2]);
        var duplicate = await cluster.StartAsync("separate-process", new Dictionary<string,string> { ["FOXWARM_REPLICA_ID"] = names[0] });
        var oldest = (string)(await top.StatusAsync())["replica"]!;
        using (var warm = await duplicate.GetAsync(slugs[0])) Assert.Equal(HttpStatusCode.Unauthorized, warm.StatusCode);
        Assert.Equal(oldest, await cluster.OwnerAsync(slugs[0]));

        await using var connection = new Npgsql.NpgsqlConnection(cluster.Database.OwnerConnectionString);
        await connection.OpenAsync();
        await using var locked = await connection.BeginTransactionAsync();
        await using (var command = new Npgsql.NpgsqlCommand("SELECT l.tenant_id FROM tenant_leases l JOIN tenants t USING(tenant_id) WHERE t.name=$1 FOR UPDATE OF l",connection,locked))
        {
            command.Parameters.Add(new Npgsql.NpgsqlParameter<string> { TypedValue=slugs[1] });
            await command.ExecuteScalarAsync();
        }
        async Task<int> Waiters() => Convert.ToInt32(await cluster.Database.ScalarAsync("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT 1 FROM tenant_leases%FOR UPDATE OF l%'"));
        var first = left.GetAsync(slugs[1]);
        await UntilAsync(async () => await Waiters() == 1,"first edge's rank-one boot is waiting on the lease",5);
        // Change the published capacity between the two edges' rank reads. Hold the registry
        // row briefly so the next heartbeat cannot undo the measured full-capacity interval.
        await cluster.Database.ScalarAsync("UPDATE replicas SET capacity=capacity || '{\"acceptingNew\":false}'::jsonb WHERE replica_id=$1",oldest);
        await using var registry = new Npgsql.NpgsqlConnection(cluster.Database.OwnerConnectionString);
        await registry.OpenAsync();
        await using var stable = await registry.BeginTransactionAsync();
        await using (var lockRow = new Npgsql.NpgsqlCommand("SELECT replica_id FROM replicas WHERE replica_id=$1 FOR NO KEY UPDATE",registry,stable))
        {
            lockRow.Parameters.Add(new Npgsql.NpgsqlParameter<string> { TypedValue=oldest });
            await lockRow.ExecuteScalarAsync();
        }
        var second = right.GetAsync(slugs[1]);
        await UntilAsync(async () => await Waiters() >= 2,"different candidate boots are waiting on the same grant",4);
        await locked.CommitAsync();
        foreach (var reply in await Task.WhenAll(first,second)) using (reply) Assert.Equal(HttpStatusCode.Unauthorized, reply.StatusCode);
        var won = await cluster.LeaseRowAsync(slugs[1]);
        Assert.Equal(1L,won.Epoch);
        using (var reply = await top.GetAsync(slugs[2])) Assert.Equal(HttpStatusCode.Unauthorized,reply.StatusCode);
        var duringFull = await cluster.LeaseRowAsync(slugs[2]);
        Assert.Equal(Placement.Rank(slugs[2],names)[1],ReplicaRegistry.LogicalName(duringFull.Owner!));
        await stable.CommitAsync();
        foreach (var accepting in new[]{true,false,true})
        {
            await cluster.Database.ScalarAsync("UPDATE replicas SET capacity=jsonb_set(capacity,'{acceptingNew}',to_jsonb($1::boolean)) WHERE replica_id=$2",accepting,oldest);
            using var reply = await duplicate.GetAsync(slugs[2]);
            Assert.Equal(HttpStatusCode.Unauthorized,reply.StatusCode);
            Assert.Equal(duringFull.Epoch,(await cluster.LeaseRowAsync(slugs[2])).Epoch);
            Assert.Equal(won.Owner,await cluster.OwnerAsync(slugs[1]));
        }
    }

    [Fact]
    public async Task ThreeReplicasServeTwentyTenantsThroughScalingRollingAndCrashRecovery()
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        var slugs = Slugs();
        var boots = await StartAsync(cluster, slugs);
        var tokens = await TokensAsync(cluster, slugs);
        using var client = new HttpClient(new SocketsHttpHandler { UseProxy = false });
        Task Wave(ReplicaProcessHarness.Replica edge) => Task.WhenAll(slugs.Select(s => ReadAsync(client,edge,s,tokens[s])));
        var before = await RowsAsync(cluster, slugs);
        var fourth = await cluster.StartAsync("replica-d", extraConfig: Egress);
        await Wave(fourth);
        var expected = slugs.Where(s => Names.Append(fourth.Name).MaxBy(n => Placement.Score(s,n)) == fourth.Name).ToArray();
        Assert.NotEmpty(expected);
        await UntilAsync(async () => (await RowsAsync(cluster, expected)).Values.All(r => r.State == "active" && ReplicaRegistry.LogicalName(r.Owner!) == fourth.Name),
            "idle tenants rebalance to the fourth boot after cooldown", 125);
        var expanded = await RowsAsync(cluster, slugs);
        foreach (var slug in slugs) Assert.Equal(before[slug].Epoch + (expected.Contains(slug) ? 1 : 0), expanded[slug].Epoch);
        fourth.Terminate();
        await Wave(boots[0]);
        Assert.Equal(HostedExit.Stopped, await fourth.ExitAsync(TimeSpan.FromSeconds(45)));
        await UntilAsync(async () => (await RowsAsync(cluster, expected)).Values.All(r => r.State == "active" && ReplicaRegistry.LogicalName(r.Owner!) != fourth.Name), "scale-in without another user request");
        var old = await RowsAsync(cluster, slugs);
        boots[2].Kill();
        await boots[2].ExitAsync(TimeSpan.FromSeconds(10));
        var crashed = slugs.Where(s => ReplicaRegistry.LogicalName(old[s].Owner!) == Names[2]).ToArray();
        Assert.NotEmpty(crashed);
        await Task.WhenAll(slugs.Except(crashed).Select(s => ReadAsync(client,boots[1],s,tokens[s])));
        // No public demand for any crashed tenant, even after the same logical name restarts.
        boots[2] = await cluster.StartAsync(Names[2], extraConfig: Egress);
        await UntilAsync(async () => (await RowsAsync(cluster, crashed)).All(pair => pair.Value.State == "active" && pair.Value.Epoch > old[pair.Key].Epoch), "autonomous recovery after a crash");
        foreach (var (slug,row) in await RowsAsync(cluster,crashed))
        {
            Assert.Equal(old[slug].Epoch+1,row.Epoch);
            Assert.True(row.AcquiredAt >= old[slug].ExpiresAt);
            Assert.NotEqual(old[slug].Owner,row.Owner);
        }
        for (var i=0;i<boots.Length;i++)
        {
            var edge = boots[(i+1)%boots.Length];
            boots[i].Terminate();
            await Wave(edge);
            Assert.Equal(HostedExit.Stopped,await boots[i].ExitAsync(TimeSpan.FromSeconds(45)));
            boots[i]=await cluster.StartAsync(Names[i], extraConfig: Egress);
            await Wave(boots[i]);
        }
        output.WriteLine($"20 tenants: {expected.Length} moved at scale-out and returned at scale-in; {crashed.Length} recovered after expiry without demand. All three logical names rolled.");
    }
    [Fact]
    public async Task BusyTenantsDrainInOneWaveAndALockedReleaseDoesNotBlockItsSiblings()
    {
        await using var cluster = await ReplicaProcessHarness.CreateAsync();
        var slugs = Slugs();
        var boots = await StartAsync(cluster,slugs);
        var tokens = await TokensAsync(cluster,slugs);
        using var client = new HttpClient(new SocketsHttpHandler { UseProxy=false });
        var before = await RowsAsync(cluster,slugs);
        var resident = slugs.Where(s => ReplicaRegistry.LogicalName(before[s].Owner!) == Names[0]).ToArray();
        Assert.Equal(12,resident.Length);
        var busy = resident.Take(9).ToArray();
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var models = new List<LoopbackResponsesServer>();
        async Task Post(string slug, string path, object body, HttpStatusCode expected)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post,$"http://127.0.0.1:{boots[1].FrontPort}/{path}");
            request.Headers.Host=slug+".test";
            request.Headers.Authorization=new("Bearer",tokens[slug]);
            request.Content=JsonContent.Create(body,body.GetType());
            using var response=await client.SendAsync(request);
            Assert.True(response.StatusCode==expected,$"{slug} {path}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        }
        try
        {
            foreach (var slug in busy)
            {
                var peer = new LoopbackResponsesServer(async (stream,_) =>
                {
                    await finish.Task;
                    await LoopbackResponsesServer.WriteResponseAsync(stream,200,"text/event-stream",Encoding.UTF8.GetBytes(
                        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"completed-in-grace\"}]}]}}\n\n"));
                });
                models.Add(peer);
                var yaml = $"default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: {peer.BaseUri}\n    models: [wire]\n";
                await Post(slug,"api/setup/models",new { yaml },HttpStatusCode.OK);
                await Post(slug,"api/sessions",new { agentId="main", sessionId="active" },HttpStatusCode.OK);
                await Post(slug,"api/sessions/active/message",new { text="Finish the turn." },HttpStatusCode.Accepted);
                await peer.Request.WaitAsync(TimeSpan.FromSeconds(30));
            }
            boots[0].Terminate();
            await UntilAsync(async () => (long)(await cluster.Database.ScalarAsync(
                "SELECT count(*) FROM tenant_leases WHERE owner_replica=$1 AND state='active' AND draining_since IS NOT NULL",before[busy[0]].Owner))! >= busy.Length,
                "the nine busy tenants are draining",10);
            var reads = slugs.ToDictionary(s => s,s => ReadAsync(client,boots[1],s,tokens[s]));
            await Task.Delay(500);
            Assert.All(busy,s => Assert.False(reads[s].IsCompleted,"A fresh request bypassed the in-progress stop: "+s));
            finish.SetResult();
            await Task.WhenAll(reads.Values);
            Assert.Equal(HostedExit.Stopped,await boots[0].ExitAsync(TimeSpan.FromSeconds(45)));
            foreach(var slug in busy)
            {
                using var request=new HttpRequestMessage(HttpMethod.Get,$"http://127.0.0.1:{boots[1].FrontPort}/api/sessions/active/history");
                request.Headers.Host=slug+".test";
                request.Headers.Authorization=new("Bearer",tokens[slug]);
                using var response=await client.SendAsync(request);
                Assert.Contains("completed-in-grace", await response.Content.ReadAsStringAsync());
                Assert.Equal(1,models[Array.IndexOf(busy,slug)].RequestCount);
            }
        }
        finally
        {
            finish.TrySetResult();
            foreach (var model in models) await model.DisposeAsync();
        }
        boots[0]=await cluster.StartAsync(Names[0],extraConfig:Egress);
        var placed=await RowsAsync(cluster,slugs);
        var held=slugs.Where(s => ReplicaRegistry.LogicalName(placed[s].Owner!)==Names[1]).ToArray();
        Assert.True(held.Length>=2);
        var stuck=held[0];
        await using var connection=new Npgsql.NpgsqlConnection(cluster.Database.OwnerConnectionString);
        await connection.OpenAsync();
        await using var tx=await connection.BeginTransactionAsync();
        await using(var command=new Npgsql.NpgsqlCommand("SELECT l.tenant_id FROM tenant_leases l JOIN tenants t USING(tenant_id) WHERE t.name=$1 FOR UPDATE OF l",connection,tx))
        {
            command.Parameters.Add(new Npgsql.NpgsqlParameter<string>{TypedValue=stuck});
            await command.ExecuteScalarAsync();
        }
        boots[1].Terminate();
        await Task.WhenAll(slugs.Where(s=>s!=stuck).Select(s=>ReadAsync(client,boots[2],s,tokens[s])));
        await UntilAsync(async () => (await RowsAsync(cluster,held.Skip(1).ToArray())).All(pair => pair.Value.Epoch>placed[pair.Key].Epoch && pair.Value.State=="active"),
            "all siblings handed back despite the locked lease");
        Assert.Equal(HostedExit.Fenced,await boots[1].ExitAsync(TimeSpan.FromSeconds(45)));
        var abandoned=await cluster.LeaseRowAsync(stuck);
        Assert.Equal("active",abandoned.State);
        Assert.Equal(placed[stuck].Epoch,abandoned.Epoch);
        await tx.RollbackAsync();
        await UntilAsync(async () => (await cluster.LeaseRowAsync(stuck)).Epoch>abandoned.Epoch,"recovery of the unconfirmed release");
        var recovered=await cluster.LeaseRowAsync(stuck);
        Assert.True(recovered.AcquiredAt>=abandoned.ExpiresAt);
        output.WriteLine($"Nine real turns completed in grace; 20/20 fresh authenticated requests succeeded during stop. {held.Length-1} siblings moved while the remaining lease was locked; that lease recovered only after expiry.");
    }
}
