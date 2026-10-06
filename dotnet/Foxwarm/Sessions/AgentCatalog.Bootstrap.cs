namespace Foxwarm.Sessions;

internal sealed partial class AgentCatalog
{
    internal async Task BootstrapMainMemoryAsync(string packageDirectory)
    {
        var frameworkTemplate = Path.Combine(
            packageDirectory,
            "templates",
            "agents",
            "00_SYSTEM.md"
        );
        if (
            !Path.Exists(FrameworkSystemPath)
            && !Path.Exists(MainFallbackSystemPath)
            && File.Exists(frameworkTemplate)
        )
            await CopyMissingAsync(frameworkTemplate, FrameworkSystemPath);
        var memory = MemoryDirectory("main");
        if (Directory.Exists(memory) && Directory.EnumerateFileSystemEntries(memory).Any())
            return;
        Directory.CreateDirectory(memory);
        var templates = Path.Combine(packageDirectory, "templates", "main", "memory");
        foreach (var template in Directory.EnumerateFiles(templates).Order(StringComparer.Ordinal))
            await CopyMissingAsync(template, Path.Combine(memory, Path.GetFileName(template)));
    }

    private static async Task CopyMissingAsync(string source, string target)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        await using var input = new FileStream(
            source,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            8192,
            true
        );
        FileStream destination;
        try
        {
            destination = new FileStream(
                target,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                8192,
                true
            );
        }
        catch (IOException) when (File.Exists(target))
        {
            return;
        }
        await using var output = destination;
        await input.CopyToAsync(output);
        await output.FlushAsync();
    }
}
