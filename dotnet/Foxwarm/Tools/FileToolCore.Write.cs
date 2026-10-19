using System.Text;

namespace Foxwarm.Tools;

internal static partial class FileToolCore
{
    internal static async Task<bool> WriteAtomic(
        string destination,
        string content,
        bool overwrite,
        Action validatePath,
        CancellationToken cancellationToken
    ) =>
        await WriteBytesAtomic(
            destination,
            Encoding.UTF8.GetBytes(content),
            overwrite,
            validatePath,
            cancellationToken
        );

    internal static async Task<bool> WriteBytesAtomic(
        string destination,
        ReadOnlyMemory<byte> bytes,
        bool overwrite,
        Action validatePath,
        CancellationToken cancellationToken
    )
        => await WriteStreamAtomic(destination, overwrite, validatePath,
            stream => stream.WriteAsync(bytes, cancellationToken).AsTask(), cancellationToken);

    internal static async Task<bool> CopyPathAtomic(
        string source, string destination, bool overwrite, Action validatePath,
        CancellationToken cancellationToken)
    {
        await using var input = new FileStream(source, FileMode.Open, FileAccess.Read,
            FileShare.Read, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        return await WriteStreamAtomic(destination, overwrite, validatePath,
            stream => input.CopyToAsync(stream, cancellationToken), cancellationToken);
    }

    private static async Task<bool> WriteStreamAtomic(string destination, bool overwrite,
        Action validatePath, Func<Stream, Task> write, CancellationToken cancellationToken)
    {
        // Overwriting follows the final symlink; replacing the link itself is not a content write.
        if (
            !overwrite
            && (
                File.Exists(destination)
                || Directory.Exists(destination)
                || new FileInfo(destination).LinkTarget is not null
            )
        )
            return false;
        destination = AuthorizationPaths.CanonicalPotential(destination);
        var temp = Path.Combine(
            Path.GetDirectoryName(destination)!,
            $".foxwarm-write-{Guid.NewGuid():N}"
        );
        try
        {
            await using (
                var stream = new FileStream(
                    temp,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    8192,
                    FileOptions.Asynchronous
                )
            )
            {
                await write(stream);
                await stream.FlushAsync(cancellationToken);
            }
            validatePath();
            if (Directory.Exists(destination) || File.Exists(destination) && !overwrite)
                return false;
            try
            {
                File.Move(temp, destination, overwrite);
            }
            catch (IOException) when (!overwrite && File.Exists(destination))
            {
                return false;
            }
            return true;
        }
        finally
        {
            if (File.Exists(temp))
                File.Delete(temp);
        }
    }
}
