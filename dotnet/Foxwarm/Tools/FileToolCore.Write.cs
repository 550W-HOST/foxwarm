using System.Text;

namespace Foxwarm.Tools;

internal static partial class FileToolCore
{
    internal static async Task<bool> WriteAtomic(string destination, string content, bool overwrite, Action validatePath, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        var temp = Path.Combine(Path.GetDirectoryName(destination)!, $".foxwarm-write-{Guid.NewGuid():N}");
        try
        {
            await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, FileOptions.Asynchronous))
            { await stream.WriteAsync(bytes, cancellationToken); await stream.FlushAsync(cancellationToken); }
            validatePath();
            if (Directory.Exists(destination) || File.Exists(destination) && !overwrite) return false;
            try { File.Move(temp, destination, overwrite); }
            catch (IOException) when (!overwrite && File.Exists(destination)) { return false; }
            return true;
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
