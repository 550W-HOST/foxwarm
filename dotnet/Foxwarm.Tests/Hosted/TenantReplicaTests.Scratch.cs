using System.Security.Cryptography;

namespace Foxwarm.Tests.Hosted;

public sealed partial class TenantReplicaTests
{
    [Fact]
    public async Task DeletionCleansPriorScratchOnEveryReplica()
    {
        await using var database = await (await PostgresServer.SharedAsync()).CreateDatabaseAsync();
        await AddTenantAsync(database, "alpha");
        await AddTenantAsync(database, "beta");
        using var temp = new TempDirectory();
        var alpha = await database.TenantIdAsync("alpha");
        var beta = await database.TenantIdAsync("beta");
        var roots = new[] { Path.Combine(temp.Path, "first"), Path.Combine(temp.Path, "second") };
        foreach (var root in roots)
            foreach (var id in new[] { alpha, beta })
                File.WriteAllText(Path.Combine(Directory.CreateDirectory(Path.Combine(root, "t", id.ToString())).FullName, "prior.log"), "record");
        var key = RandomNumberGenerator.GetBytes(32);
        await using var first = await StartReplicaAsync(database, "first", key, scratchRoot: roots[0]);
        await first.WhoAmIAsync("alpha");
        await using var second = await StartReplicaAsync(database, "second", key, scratchRoot: roots[1]);
        first.DrainGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        await database.ExecuteOwnerAsync("UPDATE tenants SET state='deleting' WHERE name='alpha'");
        await UntilAsync(() => first.EventList().Contains("alpha:dispose"), "the local generation started retiring");
        await UntilAsync(() => !Directory.Exists(Path.Combine(roots[1], "t", alpha.ToString())), "the previous replica cleaned its scratch");
        Assert.True(File.Exists(Path.Combine(roots[0], "t", alpha.ToString(), "prior.log")));
        first.DrainGate.TrySetResult();
        await UntilAsync(() => roots.All(root => !Directory.Exists(Path.Combine(root, "t", alpha.ToString()))), "both replicas cleaned the deleted tenant", TimeSpan.FromSeconds(45));
        Assert.All(roots, root => Assert.True(File.Exists(Path.Combine(root, "t", beta.ToString(), "prior.log"))));
    }
}
