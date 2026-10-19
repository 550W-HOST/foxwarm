using System.Text.Json.Nodes;

namespace Foxwarm.Code;

internal static class CodeGitService
{
    internal static Task<byte[]> RunAsync(
        string workspace,
        string[] args,
        CancellationToken token,
        int limit = 10 * 1024 * 1024,
        bool discover = false
    ) =>
        Local(() =>
            CodeGitOperations.RunAsync(
                CodeNativePaths.Native(workspace),
                args,
                token,
                limit,
                discover
            )
        );

    internal static async Task<JsonObject> StatusAsync(string workspace, CancellationToken token) =>
        Present(
            await Local(() =>
                CodeGitOperations.StatusAsync(CodeNativePaths.Native(workspace), token)
            )
        );

    internal static async Task<JsonObject> CommitAsync(
        string workspace,
        string? id,
        CancellationToken token
    ) =>
        Present(
            await Local(() =>
                CodeGitOperations.CommitAsync(CodeNativePaths.Native(workspace), id, token)
            )
        );

    internal static Task<byte[]> ContentAsync(
        string workspace,
        string? relative,
        string? side,
        string? reference,
        CancellationToken token
    ) =>
        Local(() =>
            CodeGitOperations.ContentAsync(
                CodeNativePaths.Native(workspace),
                relative,
                side ?? "base",
                JsonValue.Create(reference),
                token
            )
        );

    private static async Task<T> Local<T>(Func<Task<T>> operation)
    {
        try
        {
            return await operation();
        }
        catch (CodeServiceException error) when (error.Code == "Unavailable")
        {
            throw new CodeServiceException(
                "Unavailable",
                "Git is unavailable on Main.",
                inner: error
            );
        }
    }

    private static JsonObject Present(JsonObject value)
    {
        value["nodeId"] = "master";
        value["workspace"] = CodeNativePaths.Transport(value["workspace"]!.GetValue<string>());
        if (value.ContainsKey("topLevel"))
            value["topLevel"] = CodeNativePaths.Transport(value["topLevel"]!.GetValue<string>());
        return value;
    }
}
