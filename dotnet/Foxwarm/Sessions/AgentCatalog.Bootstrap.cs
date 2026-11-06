namespace Foxwarm.Sessions;

internal sealed partial class AgentCatalog
{
    internal async Task BootstrapMainMemoryAsync(string packageDirectory)
    {
        await RetireCopiedFrameworkPromptAsync();
        var memory = MemoryDirectory("main");
        if (Directory.Exists(memory) && Directory.EnumerateFileSystemEntries(memory).Any())
            return;
        Directory.CreateDirectory(memory);
        var templates = Path.Combine(packageDirectory, "templates", "main", "memory");
        foreach (var template in Directory.EnumerateFiles(templates).Order(StringComparer.Ordinal))
            await CopyMissingAsync(template, Path.Combine(memory, Path.GetFileName(template)));
    }

    /// <summary>
    /// Removes framework prompt files that are unedited copies of a released template, so the
    /// bundled template applies. An edited file still replaces the bundled prompt.
    /// </summary>
    private async Task RetireCopiedFrameworkPromptAsync()
    {
        var root = await ReleasedCopyAsync(FrameworkSystemPath);
        var fallback = await ReleasedCopyAsync(MainFallbackSystemPath);
        // While the root file exists, an edited main fallback is inactive; removing an
        // unedited root would activate it instead of the bundled prompt.
        if (root == true && fallback != false)
            File.Delete(FrameworkSystemPath);
        if (fallback == true)
            File.Delete(MainFallbackSystemPath);
        var replacement =
            File.Exists(FrameworkSystemPath) ? FrameworkSystemPath
            : File.Exists(MainFallbackSystemPath) ? MainFallbackSystemPath
            : null;
        if (replacement is not null)
            Console.Error.WriteLine(
                $"Framework prompt: {replacement} replaces the bundled framework prompt, so framework prompt updates are not applied. "
                    + $"Move installation-specific instructions to {FrameworkLocalPath} and delete {replacement} to use the bundled prompt."
            );
    }

    private static async Task<bool?> ReleasedCopyAsync(string path) =>
        File.Exists(path)
            ? FrameworkPrompt.IsUnmodifiedReleasedCopy(await File.ReadAllBytesAsync(path))
            : null;

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
