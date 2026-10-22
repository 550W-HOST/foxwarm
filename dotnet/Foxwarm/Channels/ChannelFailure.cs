namespace Foxwarm.Channels;

// Only fixed owner stages and typed numeric status cross the diagnostic boundary.
internal sealed class ChannelFailure(string stage, Exception error) : IOException(stage, error)
{
    internal static string Describe(Exception error) =>
        error switch
        {
            ChannelFailure failure => failure.Message + ": " + Describe(failure.InnerException!),
            TelegramApiException telegram => $"Telegram API request failed ({telegram.Code}).",
            QQBotApiException qq =>
                $"QQ Bot API request failed (HTTP {qq.Status?.ToString() ?? "unknown"}, code {qq.Code?.ToString() ?? "none"}).",
            QQBotGatewayException gateway =>
                $"QQ Bot gateway {gateway.Event} ({gateway.Code?.ToString() ?? "no close code"}).",
            _ => MainLog.SafeFailure(error),
        };
}

internal sealed class QQBotGatewayException(string action, int? code = null) : IOException
{
    internal string Event { get; } = action;
    internal int? Code { get; } = code;
}
