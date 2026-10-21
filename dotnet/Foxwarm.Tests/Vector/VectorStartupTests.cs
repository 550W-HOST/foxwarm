using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorStartupTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Corrupt_derived_manifest_retains_unavailable_placement_and_disposes(bool child)
    {
        await using var f = await VectorFixture.CreateAsync();
        await using (var seed = new VectorService(f.Data, f.Configuration()))
        {
            await seed.StartAsync();
            await seed.WaitForStartupAsync();
        }
        var versions = Path.Combine(f.Dense, "messages_v7.lance", "_versions");
        // Lance v2 manifest filenames invert the version number: smallest is latest.
        var manifest = Directory.GetFiles(versions, "*.manifest").Order().First();
        Assert.True(new FileInfo(manifest).Length > 0);
        await File.WriteAllBytesAsync(manifest, []);
        await using var service = new VectorService(f.Data, f.Configuration(child));
        await Assert.ThrowsAnyAsync<Exception>(() => service.StartAsync());
        Assert.Equal(child ? "worker" : "local", service.Mode);
        Assert.True(service.Configuration.Enabled);
        Assert.False(service.Ready);
        foreach (var operation in new Func<Task>[]
        {
            () => service.SearchAsync("synthetic query", 5),
            () => service.StatusAsync("main/fixture"),
            () => service.ForceAsync("main/fixture", 1, 0),
            () => service.ScheduleAsync("main/fixture", 1, 10, 0),
            () => service.WaitForStartupAsync(),
        })
        {
            var error = await Assert.ThrowsAsync<VectorUnavailableException>(operation);
            Assert.Equal("VECTOR_UNAVAILABLE", error.Code);
            Assert.True(error.Retryable);
        }
        Assert.Empty(f.Peer.Requests);
        Assert.Equal(0, new FileInfo(manifest).Length);
    }

}
