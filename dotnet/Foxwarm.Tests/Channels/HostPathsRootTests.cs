using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class HostPathsRootTests
{
    private static readonly string Separator = Path.DirectorySeparatorChar.ToString();

    [Fact]
    public void Roots_ending_in_a_separator_are_captured_without_it()
    {
        using var temp = new TempDirectory();
        var app = Path.Combine(temp.Path, "application");
        var resources = Path.Combine(temp.Path, "resources");
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(app);
        Directory.CreateDirectory(resources);
        Directory.CreateDirectory(data);
        File.WriteAllText(Path.Combine(app, "data_dir"), data + Separator + "\n");

        var paths = HostPaths.Capture(app + Separator, resources + Separator, _ => null);

        Assert.Equal(app, paths.ApplicationRoot);
        Assert.Equal(resources, paths.ResourceRoot);
        Assert.Equal(data, paths.DataRoot);
        Assert.Equal(Path.Combine(data, "state", "config.yaml"), paths.ConfigPath);
    }

    [Fact]
    public void A_bare_launch_uses_the_binary_directory_as_application_and_data_root()
    {
        using var temp = new TempDirectory();
        var resources = Path.Combine(temp.Path, "unpacked package");
        Directory.CreateDirectory(resources);

        // AppContext.BaseDirectory ends with a separator when nothing selects a root.
        var paths = HostPaths.Capture(null, resources + Separator, _ => null);

        Assert.Equal(resources, paths.ApplicationRoot);
        Assert.Equal(resources, paths.DataRoot);
        Assert.Equal(Path.Combine(resources, "agents"), paths.AgentsRoot);
    }

    [Fact]
    public void Authority_files_accept_a_root_that_ends_in_a_separator()
    {
        using var temp = new TempDirectory();

        var file = new LinuxAtomicJsonFile(temp.Path + Separator, Path.Combine("state", "x.json"));

        Assert.Equal(Path.Combine(temp.Path, "state", "x.json"), file.FilePath);
    }
}
