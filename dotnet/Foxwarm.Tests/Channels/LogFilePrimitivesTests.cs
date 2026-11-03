using System.Text;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class LogFilePrimitivesTests
{
    [Fact]
    public void Independent_writers_append_after_seek_and_external_append()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "shared.log");
        using var first = AppendLogFile.Open(path);
        using var second = AppendLogFile.Open(path);
        first.Write(Encoding.UTF8.GetBytes("one\n"));
        first.Flush();
        second.Write(Encoding.UTF8.GetBytes("two\n"));
        second.Flush();
        File.AppendAllText(path, "external\n");
        first.Seek(0, SeekOrigin.Begin);
        first.Write(Encoding.UTF8.GetBytes("three\n"));
        first.Flush();
        Assert.Equal("one\ntwo\nexternal\nthree\n", File.ReadAllText(path));
    }

    [Fact]
    public async Task Every_write_overload_appends_and_cancelled_writes_do_not_change_file()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "overloads.log");
        using var writer = AppendLogFile.Open(path);
        writer.WriteByte((byte)'a');
        writer.Write([0, (byte)'b', 0], 1, 1);
        File.AppendAllText(path, "c");
        await writer.WriteAsync(new byte[] { 0, (byte)'d', 0 }, 1, 1, CancellationToken.None);
        await writer.WriteAsync(new byte[] { (byte)'e' }.AsMemory());
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await writer.WriteAsync(new byte[] { (byte)'x' }.AsMemory(), cancelled.Token));
        writer.Flush();
        Assert.Equal("abcde", File.ReadAllText(path));
        writer.Dispose();
        Assert.Throws<ObjectDisposedException>(() => writer.WriteByte((byte)'x'));
    }

    [Fact]
    public void Open_handle_identity_survives_append_and_rename_but_not_replacement()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "main.log");
        File.WriteAllText(path, "old");
        using var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var original = OpenFileMetadata.Read(handle);
        Assert.Equal(3, original.Size);
        File.AppendAllText(path, " tail");
        var appended = OpenFileMetadata.Read(handle);
        Assert.Equal(original.Identity, appended.Identity);
        Assert.Equal(8, appended.Size);
        File.Move(path, path + ".old");
        File.WriteAllText(path, "new tail");
        using var replacement = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        Assert.Equal(appended, OpenFileMetadata.Read(handle));
        var changed = OpenFileMetadata.Read(replacement);
        Assert.Equal(appended.Size, changed.Size);
        Assert.NotEqual(original.Identity, changed.Identity);
    }

    [Fact]
    public void Truncation_changes_size_without_changing_open_object_identity()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "main.log");
        File.WriteAllText(path, "content");
        using var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var original = OpenFileMetadata.Read(handle);
        using (var truncate = new FileStream(path, FileMode.Truncate, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete)) { }
        var truncated = OpenFileMetadata.Read(handle);
        Assert.Equal(original.Identity, truncated.Identity);
        Assert.Equal(0, truncated.Size);
    }

    [Fact]
    public void Non_regular_file_is_rejected()
    {
        if (OperatingSystem.IsWindows()) return;
        using var handle = File.OpenHandle("/dev/null", FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        Assert.Throws<IOException>(() => OpenFileMetadata.Read(handle));
    }
}
