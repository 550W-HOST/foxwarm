using System.Diagnostics;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SourceStringLowerParityTests
{
    [Fact]
    public async Task Lowercasing_matches_JavaScript_for_every_scalar_and_contextual_sigma()
    {
        using var temp = new TempDirectory();
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(
            Path.Combine(
                VectorFixture.Repository(),
                "dotnet",
                "Foxwarm.Tests",
                "Fixtures",
                "lowercase-oracle.mjs"
            )
        );
        start.ArgumentList.Add(temp.Path);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.True(process.ExitCode == 0, await stdout + await stderr);
        Assert.Equal(
            await File.ReadAllTextAsync(Path.Combine(temp.Path, "lower-expected.txt")),
            SourceStringLower.Lower(
                await File.ReadAllTextAsync(Path.Combine(temp.Path, "lower-input.txt"))
            )
        );
    }
}
