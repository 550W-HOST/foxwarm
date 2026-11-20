using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Authentication;

namespace Foxwarm.Channels;

// Only fixed owner stages and typed numeric status cross the diagnostic boundary.
internal sealed class ChannelFailure(string stage, Exception error) : IOException(stage, error)
{
    // The status sentence: what failed and the useful cause, without exception type names,
    // vendor text, URLs, credentials or paths. Full detail stays in the Main server log.
    internal static string Describe(Exception error, string fallbackSubject = "Channel start") =>
        error switch
        {
            ChannelFailure failure => Sentence(failure.Message, failure.InnerException!),
            ChannelRequestException
            or Foxwarm.Secrets.SecretUnavailableException
            or Foxwarm.Secrets.SecretStoreLockedException => error.Message,
            _ => Sentence(fallbackSubject, error),
        };

    internal static string Sentence(string subject, Exception error) =>
        subject + " failed: " + Cause(error) + ".";

    // The diagnostic form for the Main server log: owner stages and exception types only.
    internal static string Diagnostic(Exception error) =>
        error switch
        {
            ChannelFailure failure => failure.Message + ": " + Diagnostic(failure.InnerException!),
            ChannelProblem problem => problem.Message,
            TelegramApiException telegram => $"Telegram API request failed ({telegram.Code}).",
            QQBotApiException qq =>
                $"QQ Bot API request failed (HTTP {qq.Status?.ToString() ?? "unknown"}, code {qq.Code?.ToString() ?? "none"}).",
            QQBotGatewayException gateway =>
                $"QQ Bot gateway {gateway.Event} ({gateway.Code?.ToString() ?? "no close code"}).",
            WeixinHttpException weixin => $"Weixin API request failed (HTTP {weixin.Status}).",
            ChannelRequestException
            or Foxwarm.Secrets.SecretUnavailableException
            or Foxwarm.Secrets.SecretStoreLockedException => error.Message,
            _ => MainLog.SafeFailure(error),
        };

    // The most useful known cause along the exception chain, as a lower-case phrase.
    internal static string Cause(Exception? error)
    {
        for (var current = error; current is not null; current = current.InnerException)
        {
            var cause = current switch
            {
                ChannelFailure => null,
                ChannelProblem problem => problem.Message,
                TelegramApiException telegram => Telegram(telegram.Code),
                QQBotApiException qq => qq.Status is { } status
                    ? $"QQ Bot API returned HTTP {status}"
                        + (qq.Code is { } code ? $" (code {code})" : "")
                    : "QQ Bot API request failed",
                QQBotGatewayException gateway =>
                    $"the server closed the gateway connection (code {gateway.Code?.ToString() ?? "none"})",
                MatrixApiException matrix => Matrix(matrix),
                WeixinHttpException weixin => $"Weixin returned HTTP {weixin.Status}",
                Foxwarm.Secrets.SecretUnavailableException
                or Foxwarm.Secrets.SecretStoreLockedException => current.Message.TrimEnd('.'),
                HttpRequestException { StatusCode: { } http } =>
                    $"the server returned HTTP {(int)http}",
                SocketException socket => Socket(socket.SocketErrorCode),
                AuthenticationException => "the secure connection could not be established",
                TimeoutException or OperationCanceledException => "the request timed out",
                _ => null,
            };
            if (cause is not null)
                return cause;
        }
        return error switch
        {
            HttpRequestException => "the network request failed",
            WebSocketException => "the connection was lost",
            _ => "unexpected error; see the Main server log",
        };
    }

    private static string Telegram(int code) =>
        code switch
        {
            401 => "Telegram rejected the bot token (401)",
            409 => "another client is polling with the same bot token (409)",
            429 => "Telegram rate limit reached (429)",
            >= 500 => $"Telegram server error ({code})",
            _ => $"Telegram returned error {code}",
        };

    private static string Matrix(MatrixApiException error) =>
        error.Code == "M_UNKNOWN_TOKEN" ? "the access token was rejected"
        : error.Status == 429 ? "the homeserver rate limit was reached (429)"
        : $"the homeserver returned HTTP {error.Status}";

    private static string Socket(SocketError code) =>
        code switch
        {
            SocketError.TimedOut => "connection timed out",
            SocketError.ConnectionRefused => "connection refused",
            SocketError.HostNotFound or SocketError.NoData or SocketError.TryAgain =>
                "the host name could not be resolved",
            SocketError.NetworkUnreachable
            or SocketError.HostUnreachable
            or SocketError.NetworkDown => "the network is unreachable",
            SocketError.ConnectionReset
            or SocketError.ConnectionAborted
            or SocketError.OperationAborted
            or SocketError.Shutdown => "the connection was lost",
            _ => "a network error occurred",
        };

    // Whether a failed send says the channel itself is not working (network, server, rate
    // limit, rejected credentials) rather than that one message or conversation was refused.
    internal static bool ChannelLevel(Exception error, CancellationToken token = default) =>
        !token.IsCancellationRequested
        && error switch
        {
            ChannelProblem => false,
            ChannelFailure => true,
            TelegramApiException telegram => telegram.Code is 401 or 429 or >= 500,
            QQBotApiException qq => qq.Status is null or 401 or 429 or >= 500,
            MatrixApiException matrix => matrix.Status is 401 or 429 or >= 500,
            WeixinHttpException weixin => weixin.Status is 401 or 429 or >= 500,
            HttpRequestException { StatusCode: { } status } => (int)status is 401 or 429 or >= 500,
            InvalidOperationException or InvalidDataException or ArgumentException => false,
            _ => true,
        };
}

// A fixed, secret-free cause phrase (lower case, no final period) shown as written.
internal sealed class ChannelProblem(string message) : IOException(message);

// A refused channel operation whose message is already a complete, safe sentence.
internal sealed class ChannelRequestException(string message) : InvalidOperationException(message);

internal sealed class QQBotGatewayException(string action, int? code = null) : IOException
{
    internal string Event { get; } = action;
    internal int? Code { get; } = code;
}
