using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

/// <summary>Native Main file semantics; caller authorization owns physical path restrictions.</summary>
public sealed partial class WorkspaceTools : ITurnToolExecutor
{
    internal string ToolDirectory => root;
    internal bool Programmatic { get; set; }
    internal Foxwarm.ToolScript.ToolScriptDataBudget? ScriptBudget { get; set; }
    private const int MaxBytes = 1024 * 1024;
    private readonly string root;
    private readonly ITargetFileOperations? targetFiles;
    private readonly PendingWriteRefs pending = new();
    private readonly string sessionId = "standalone";
    private readonly string agent = "main";
    private readonly object? lifetime;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    // The caller-approved model-facing definitions are intentionally kept verbatim.
    public static JsonArray Definitions()
    {
        var definitions = new JsonArray(
            new JsonObject
            {
                ["type"] = "function",
                ["name"] = "read",
                ["description"] =
                    "Read a file, view an image, or list a directory. Large text files are shown as bounded excerpts with their file size; use a line range to inspect a specific section. Directory listings are non-recursive and show up to 50 entries by default.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["properties"] = new JsonObject
                    {
                        ["filePath"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "File or directory path. Relative paths use the session working directory, or the agent directory when unset. Absolute paths and ~/ paths are accepted subject to permissions. A leading $fw_agentdir or $fw_tmp expands to the agent directory or its tmp directory. Other leading $ names are rejected.",
                        },
                        ["startLine"] = new JsonObject
                        {
                            ["type"] = "number",
                            ["description"] =
                                "First line to read, counting from 1. For directories, the first entry to list. Omit or use 0 to start at the beginning.",
                        },
                        ["endLine"] = new JsonObject
                        {
                            ["type"] = "number",
                            ["description"] =
                                "Last line or directory entry to include, counting from 1. Omit or use 0 for the default range.",
                        },
                    },
                    ["required"] = new JsonArray("filePath"),
                },
                ["strict"] = false,
            },
            new JsonObject
            {
                ["type"] = "function",
                ["name"] = "write",
                ["description"] =
                    "Write text to a file. Existing files are protected unless overwrite is true; missing parent directories are created only when createDirs is true. Supply content for a new write, or contentRef to retry previously cached content.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["additionalProperties"] = false,
                    ["properties"] = new JsonObject
                    {
                        ["filePath"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Destination path. Relative paths use the session working directory, or the agent directory when unset. Absolute paths and ~/ paths are accepted subject to permissions. A leading $fw_agentdir or $fw_tmp expands to the agent directory or its tmp directory. Other leading $ names are rejected.",
                        },
                        ["content"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Complete file contents. Use either content or contentRef, not both.",
                        },
                        ["overwrite"] = new JsonObject
                        {
                            ["type"] = "boolean",
                            ["description"] =
                                "Allow replacement of an existing file. Defaults to false.",
                        },
                        ["contentRef"] = new JsonObject
                        {
                            ["type"] = "string",
                            ["description"] =
                                "Reference returned by a write that failed because the file existed or its parent directory was missing. Reuse it with overwrite=true to write the same cached text to this or another permitted path in the same session and agent. Set createDirs=true if needed. To change the text, supply content instead. References are short-lived.",
                        },
                        ["createDirs"] = new JsonObject
                        {
                            ["type"] = "boolean",
                            ["description"] =
                                "Create missing parent directories. Defaults to false.",
                        },
                    },
                    ["required"] = new JsonArray("filePath"),
                },
                ["strict"] = false,
            }
        );
        definitions.Add(EditDefinition());
        definitions.Add(PatchDefinition());
        return definitions;
    }

    internal MainNativePaths Paths { get; private set; } = null!;
    internal Action<JsonArray>? ResolvedPaths { get; set; }

    private void ReportPaths(params (string Raw, string Path)[] paths) =>
        (targetFiles is null ? ResolvedPaths : null)?.Invoke(
            new JsonArray(
                paths
                    .Select(pair =>
                        (JsonNode?)
                            new JsonObject
                            {
                                ["raw"] = pair.Raw,
                                ["resolved"] = pair.Path,
                                ["nodeId"] = "master",
                            }
                    )
                    .ToArray()
            )
        );

    public WorkspaceTools(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        this.root = Path.GetFullPath(root);
        Paths = MainNativePaths.Default(this.root);
        if (
            Directory.Exists(this.root)
            && (File.GetAttributes(this.root) & FileAttributes.ReparsePoint) != 0
        )
            throw new InvalidOperationException("Workspace root cannot be a symbolic link.");
    }

    internal WorkspaceTools(
        string root,
        PendingWriteRefs pending,
        string sessionId,
        string agent,
        object? lifetime = null,
        string? cwd = null
    )
        : this(root)
    {
        this.pending = pending;
        this.sessionId = sessionId;
        this.agent = agent;
        this.lifetime = lifetime;
        Paths = MainNativePaths.Default(this.root, cwd);
    }

    internal WorkspaceTools(
        ITargetFileOperations operations,
        PendingWriteRefs pending,
        string sessionId,
        string agent,
        object? lifetime = null
    )
    {
        root = "";
        targetFiles = operations;
        this.pending = pending;
        this.sessionId = sessionId;
        this.agent = agent;
        this.lifetime = lifetime;
    }

    async Task<JsonNode?> ITurnToolExecutor.ExecuteAsync(
        JsonObject call,
        CancellationToken token
    ) => await ExecuteAsync(call, token);

    public async Task<JsonObject> ExecuteAsync(
        JsonObject functionCall,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        var name = functionCall["name"]?.GetValue<string>();
        var args = functionCall["args"] as JsonObject;
        if (name is "edit" or "apply_patch")
            return await ExecuteEditPatchAsync(name, args, cancellationToken);
        if (name is not ("read" or "write"))
            return Error("unknown_tool", "Unsupported workspace tool.");
        if (
            args is null
            || args["filePath"] is not JsonValue pathValue
            || !pathValue.TryGetValue<string>(out var pathText)
        )
            return Error("invalid_tool_arguments", "Invalid workspace tool arguments.");
        try
        {
            var allowed =
                name == "read"
                    ? new[] { "filePath", "startLine", "endLine" }
                    : ["filePath", "content", "contentRef", "overwrite", "createDirs"];
            if (args.Any(item => !allowed.Contains(item.Key)))
                return Error("invalid_tool_arguments", "Unsupported file tool argument.");
            if (name == "read")
            {
                double? Bound(string key)
                {
                    if (args[key] is null)
                        return null;
                    return SessionWait.Number(args[key])
                        ?? throw new InvalidDataException(key + " must be a number.");
                }
                var first = Bound("startLine");
                var last = Bound("endLine");
                var path = ResolveReadWrite(pathText, read: true);
                if (
                    !await DirectoryExistsAsync(path, cancellationToken)
                    && !await RegularFileAsync(path, cancellationToken)
                )
                {
                    if (Programmatic)
                        throw new FileNotFoundException(
                            "Regular file or directory not found.",
                            path
                        );
                    return Error("not_file", "Regular file or directory not found.");
                }
                var mime = Path.GetExtension(path).ToLowerInvariant() switch
                {
                    ".png" => "image/png",
                    ".jpg" or ".jpeg" => "image/jpeg",
                    ".gif" => "image/gif",
                    ".webp" => "image/webp",
                    ".bmp" => "image/bmp",
                    _ => null,
                };
                JsonObject? data = null;
                if (ScriptBudget is not null)
                    ScriptBudget.Charge(
                        mime is not null && !await DirectoryExistsAsync(path, cancellationToken)
                            ? checked(12L * await SizeAsync(path, cancellationToken))
                            : 32L * MaxBytes
                    );
                var result =
                    mime is not null && !await DirectoryExistsAsync(path, cancellationToken)
                        ? new JsonObject
                        {
                            ["output"] = "[Image loaded: " + pathText + "]",
                            ["mimeType"] = mime,
                            ["inlineData"] = new JsonObject
                            {
                                ["mimeType"] = mime,
                                ["data"] = Convert.ToBase64String(
                                    await ReadBytesAsync(path, cancellationToken)
                                ),
                            },
                        }
                        : new JsonObject
                        {
                            ["output"] = await ReadFormattedAsync(
                                path,
                                pathText,
                                first,
                                last,
                                cancellationToken,
                                Programmatic ? value => data = value : null
                            ),
                        };
                if (data is not null)
                    foreach (var (key, value) in data)
                        result[key] = value?.DeepClone();
                ReportPaths((pathText, path));
                return result;
            }
            foreach (var key in new[] { "overwrite", "createDirs" })
                if (
                    args.ContainsKey(key)
                    && (args[key] is not JsonValue flag || !flag.TryGetValue<bool>(out _))
                )
                    throw new InvalidDataException(key + " must be boolean.");
            var destination = ResolveReadWrite(pathText, read: false);
            var reference = SessionGoal.Trim(SessionWait.Text(args["contentRef"]) ?? "");
            var overwrite = args["overwrite"]?.GetValue<bool>() == true;
            var createDirs = args["createDirs"]?.GetValue<bool>() == true;
            string content;
            if (reference.Length > 0)
            {
                if (args.ContainsKey("content"))
                    throw new InvalidDataException(
                        "write accepts either content or contentRef, not both."
                    );
                if (!overwrite)
                    throw new InvalidDataException(
                        "write with contentRef requires overwrite=true."
                    );
                content = pending.Peek(reference, sessionId, agent, lifetime);
            }
            else
                content =
                    SessionWait.Text(args["content"])
                    ?? throw new InvalidDataException(
                        "write requires content, or contentRef with overwrite=true from a previous write attempt."
                    );
            string Hint(bool parents)
            {
                var id =
                    reference.Length > 0
                        ? reference
                        : pending.Register(sessionId, agent, content, lifetime);
                if (id is null)
                    return " The attempted content was too large to cache for contentRef retry; call write again with content and "
                        + (parents ? "createDirs=true." : "overwrite=true.");
                return $" The attempted content is cached. Retry write({{ filePath: {System.Text.Json.JsonSerializer.Serialize(pathText)}, contentRef: {System.Text.Json.JsonSerializer.Serialize(id)}, overwrite: true{(parents ? ", createDirs: true" : "")} }}). Use contentRef without content, or supply new content to replace it. The same cached text may be written to another permitted path in this session and agent. The contentRef expires in 15 minutes.";
            }
            if (targetFiles is not null)
            {
                var failed = await WriteTargetAsync(
                    destination,
                    pathText,
                    content,
                    overwrite,
                    createDirs,
                    Hint,
                    cancellationToken
                );
                if (failed is not null)
                    return failed;
            }
            else
            {
                var parent = Path.GetDirectoryName(destination)!;
                if (!Directory.Exists(parent))
                {
                    var current = parent;
                    while (!Directory.Exists(current))
                    {
                        if (File.Exists(current))
                            return Error(
                                "not_directory",
                                $"Parent path is not a directory: {current}."
                            );
                        current =
                            Path.GetDirectoryName(current)
                            ?? throw new IOException("Missing filesystem root.");
                    }
                    if (!createDirs)
                        return Error(
                            "missing_parent",
                            $"Parent directory does not exist: {parent}. write does not create parent directories by default. Retry with createDirs=true."
                                + Hint(true)
                        );
                    Directory.CreateDirectory(parent);
                }
                if (Directory.Exists(destination) || File.Exists(destination) && !overwrite)
                    return Error(
                        "file_exists",
                        $"File already exists: {pathText}. Use overwrite=true to overwrite, or use edit to modify it."
                            + Hint(false)
                    );
                if (File.Exists(destination) && !RegularFile(destination))
                    return Error("not_file", "Write target must be a regular file.");
                var written = await FileToolCore.WriteAtomic(
                    destination,
                    content,
                    overwrite,
                    () => _ = ResolveReadWrite(pathText, read: false),
                    cancellationToken
                );
                if (!written)
                    return Error("file_exists", $"File already exists: {pathText}." + Hint(false));
            }
            if (reference.Length > 0)
                pending.Consume(reference);
            ReportPaths((pathText, destination));
            return new JsonObject { ["output"] = "written" };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (InvalidDataException error)
        {
            if (Programmatic)
                throw;
            return Error("invalid_tool_arguments", error.Message);
        }
        catch (ArgumentException)
        {
            if (Programmatic)
                throw;
            return Error("invalid_path", "Invalid path.");
        }
        catch (IOException error)
        {
            if (Programmatic)
                throw;
            return Error("tool_io_error", error.Message);
        }
        catch (UnauthorizedAccessException)
        {
            if (Programmatic)
                throw;
            return Error("tool_io_error", "Workspace access denied.");
        }
    }

    private string ResolveReadWrite(string path, bool read)
    {
        if (targetFiles is null)
            return Paths.FilePath(path);
        TargetFileContent.RequirePath(path);
        return path;
    }

    internal static bool RegularFile(string path)
    {
        if (!File.Exists(path))
            return false;
        if (!OperatingSystem.IsLinux())
            return (
                    File.GetAttributes(path)
                    & (
                        FileAttributes.Directory
                        | FileAttributes.Device
                        | FileAttributes.ReparsePoint
                    )
                ) == 0;
        // Linux statx has a fixed 256-byte ABI; only the mode/type field is needed.
        return Statx(-100, path, 0, 1, out var info) == 0 && (info.Mode & 0xf000) == 0x8000;
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct FileTypeInfo
    {
        [FieldOffset(28)]
        internal ushort Mode;
    }

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(
        int directory,
        string path,
        int flags,
        uint mask,
        out FileTypeInfo info
    );

    private static JsonObject Error(string kind, string message) =>
        UnsupportedTurnToolExecutor.ToolError(kind, message);
}
