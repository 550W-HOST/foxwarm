namespace Foxwarm.Code;

internal sealed class CodeServiceException(
    string code,
    string message,
    int? status = null,
    Exception? inner = null
) : Exception(message, inner)
{
    internal string Code { get; } = code;
    internal int Status { get; } =
        status
        ?? code switch
        {
            "FileNotFound" => 404,
            "FileExists" or "DirectoryNotEmpty" => 409,
            "NoPermissions" => 403,
            "Unavailable" => 503,
            "PayloadTooLarge" => 413,
            "InvalidNode"
            or "InvalidPath"
            or "FileNotADirectory"
            or "FileIsADirectory"
            or "UnsupportedNode"
            or "UnsupportedOperation"
            or "UnsupportedService" => 400,
            "GitError" or "InvalidCommit" or "InvalidGitResponse" => 422,
            _ => 500,
        };

    internal static Exception FileError(Exception error) =>
        error switch
        {
            CodeServiceException => error,
            UnauthorizedAccessException => new CodeServiceException(
                "NoPermissions",
                error.Message,
                inner: error
            ),
            FileNotFoundException or DirectoryNotFoundException => new CodeServiceException(
                "FileNotFound",
                error.Message,
                inner: error
            ),
            _ => new CodeServiceException("Unknown", error.Message, inner: error),
        };
}
