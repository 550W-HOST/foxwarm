using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.Tools;

public sealed partial class WorkspaceTools
{
    private async Task<TargetFileStat?> TargetStatAsync(string path, CancellationToken token)
    {
        try
        {
            return await targetFiles!.StatAsync(path, token);
        }
        catch (NodeProviderException error) when (error.Code == "ENOENT")
        {
            return null;
        }
    }

    private async Task<bool> DirectoryExistsAsync(string path, CancellationToken token) =>
        targetFiles is null
            ? Directory.Exists(path)
            : (await TargetStatAsync(path, token))?.Kind == "directory";

    private async Task<bool> FileExistsAsync(string path, CancellationToken token) =>
        targetFiles is null
            ? File.Exists(path)
            : (await TargetStatAsync(path, token)) is { Kind: not "directory" };

    private async Task<bool> RegularFileAsync(string path, CancellationToken token) =>
        targetFiles is null
            ? RegularFile(path)
            : (await TargetStatAsync(path, token)) is { Kind: not "directory" };

    private async Task<long> SizeAsync(string path, CancellationToken token) =>
        targetFiles is null
            ? new FileInfo(path).Length
            : (await targetFiles.StatAsync(path, token)).Size;

    private Task<string> ParentAsync(string path, CancellationToken token) =>
        targetFiles is null
            ? Task.FromResult(Path.GetDirectoryName(path)!)
            : targetFiles.ParentAsync(path, token);

    private async Task MakeDirectoryAsync(string path, CancellationToken token)
    {
        if (targetFiles is null)
            Directory.CreateDirectory(path);
        else
            await targetFiles.MakeDirectoryAsync(path, token);
    }

    private async Task RemoveFileAsync(string path, CancellationToken token)
    {
        if (targetFiles is null)
            File.Delete(path);
        else
            await targetFiles.RemoveAsync(path, token);
    }

    private Task<byte[]> ReadBytesAsync(string path, CancellationToken token) =>
        targetFiles is null
            ? File.ReadAllBytesAsync(path, token)
            : TargetFileContent.ReadAsync(targetFiles, path, int.MaxValue, token);

    private async Task<JsonObject?> WriteTargetAsync(
        string path,
        string display,
        string content,
        bool overwrite,
        bool createDirs,
        Func<bool, string> hint,
        CancellationToken token
    )
    {
        var parent = await targetFiles!.ParentAsync(path, token);
        if (createDirs)
            await targetFiles.MakeDirectoryAsync(parent, token);
        try
        {
            await targetFiles.WriteAsync(
                path,
                System.Text.Encoding.UTF8.GetBytes(content),
                overwrite ? "w" : "wx",
                token
            );
        }
        catch (NodeProviderException error) when (!overwrite && error.Code == "EEXIST")
        {
            return Error(
                "file_exists",
                $"File already exists: {display}. Use overwrite=true to overwrite, or use edit to modify it."
                    + hint(false)
            );
        }
        catch (NodeProviderException error)
            when (!createDirs && error.Code is "ENOENT" or "ENOTDIR")
        {
            var stat = await TargetStatAsync(parent, token);
            if (stat is null)
                return Error(
                    "missing_parent",
                    $"Parent directory does not exist: {parent}. write does not create parent directories by default. Retry with createDirs=true."
                        + hint(true)
                );
            if (stat.Kind != "directory")
                return Error("not_directory", $"Parent path is not a directory: {parent}.");
            throw;
        }
        return null;
    }

    private async Task<string> ReadFormattedAsync(
        string path,
        string display,
        double? first,
        double? last,
        CancellationToken token,
        Action<JsonObject>? data
    )
    {
        if (targetFiles is null)
            return await FileToolCore.Read(path, display, first, last, token, data);
        var stat = await targetFiles.StatAsync(path, token);
        if (stat.Kind == "directory")
        {
            var entries = (await targetFiles.ReadDirectoryAsync(path, token))
                .OrderBy(
                    entry => entry.Name,
                    StringComparer.Create(CultureInfo.GetCultureInfo("en-US"), false)
                )
                .ToArray();
            return FileToolCore.FormatDirectory(display, first, last, entries);
        }
        return await FileToolCore.ReadContent(
            path,
            display,
            stat.Size,
            first,
            last,
            (offset, count) => targetFiles.ReadAsync(path, offset, count, token),
            data
        );
    }
}
