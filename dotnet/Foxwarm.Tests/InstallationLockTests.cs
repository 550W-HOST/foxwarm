using System.Diagnostics;

namespace Foxwarm.Tests;

public sealed class InstallationLockTests
{
    [Fact]
    public void A_held_data_directory_refuses_a_second_holder_until_released()
    {
        using var temp = new TempDirectory();
        var first = InstallationLock.Acquire(temp.Path);
        try
        {
            if (!OperatingSystem.IsWindows())
                Assert.Equal(
                    Environment.ProcessId + "\n",
                    ReadWithoutLock(InstallationLock.PathFor(temp.Path))
                );
            var refused = Assert.Throws<InstallationLockedException>(() =>
                InstallationLock.Acquire(temp.Path)
            );
            Assert.Equal(Path.GetFullPath(temp.Path), refused.DataRoot);
            Assert.Contains(Path.GetFullPath(temp.Path), refused.Message);
        }
        finally
        {
            first.Dispose();
        }
        using var second = InstallationLock.Acquire(temp.Path);
        Assert.True(File.Exists(InstallationLock.PathFor(temp.Path)));
    }

    [Fact]
    public void Distinct_data_directories_do_not_conflict()
    {
        using var one = new TempDirectory();
        using var two = new TempDirectory();
        using var first = InstallationLock.Acquire(one.Path);
        using var second = InstallationLock.Acquire(two.Path);
        Assert.NotEqual(first.DataRoot, second.DataRoot);
    }

    [Fact]
    public void A_child_process_started_while_held_does_not_keep_the_lock()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var held = InstallationLock.Acquire(temp.Path);
        using var child = Process.Start(new ProcessStartInfo("/bin/sleep", "30"))!;
        try
        {
            held.Dispose();
            using var next = InstallationLock.Acquire(temp.Path);
            Assert.False(child.HasExited);
        }
        finally
        {
            held.Dispose();
            child.Kill();
            child.WaitForExit();
        }
    }

    // .NET's own readers take a shared flock, which the held lock refuses; ordinary Unix tools don't.
    private static string ReadWithoutLock(string path)
    {
        var start = new ProcessStartInfo("/bin/cat", path) { RedirectStandardOutput = true };
        using var cat = Process.Start(start)!;
        var text = cat.StandardOutput.ReadToEnd();
        cat.WaitForExit();
        return text;
    }
}
