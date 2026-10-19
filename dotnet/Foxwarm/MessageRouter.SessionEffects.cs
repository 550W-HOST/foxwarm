using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class MessageRouter
{
    private async Task HandleSessionEffectAsync(
        ExternalChannelContext source,
        string command,
        string[] args,
        SessionOwner owner
    )
    {
        switch (command)
        {
            case "/btw":
                var question = string.Join(' ', args).Trim();
                if (question.Length == 0)
                {
                    await source.Reply("Usage: /btw <message>");
                    return;
                }
                runtime.Manager.StartBtw(owner, question);
                await source.Reply(
                    "📝 BTW request started. I’ll post the result here when it finishes."
                );
                return;
            case "/delete-messages":
                var integer = System.Text.RegularExpressions.Regex.Match(
                    args.FirstOrDefault() ?? "",
                    @"^[+-]?\d+"
                );
                if (
                    !integer.Success
                    || !double.TryParse(
                        integer.Value,
                        System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture,
                        out var number
                    )
                    || number == 0
                )
                {
                    await source.Reply(
                        "Usage: `/delete-messages <num>` (positive: delete oldest, negative: delete newest)"
                    );
                    return;
                }
                var count = (int)Math.Clamp(number, int.MinValue, int.MaxValue);
                var deleted = await owner.Entry.SaveLane.DeleteMessagesAsync(count);
                await source.Reply(
                    $"✅ Deleted {deleted.Deleted} messages. Remaining: {deleted.Remaining}."
                );
                return;
            case "/verbose":
                if (args.Length == 0)
                {
                    var verbose = owner.Entry.WithState(state =>
                        SessionCatalog.Flag(state.AuthorityEnvelope["verbose"])
                    );
                    await source.Reply($"Verbose mode is currently *{(verbose ? "on" : "off")}*.");
                    return;
                }
                var value = args[0].ToLowerInvariant();
                if (value is not ("on" or "off"))
                {
                    await source.Reply("Usage: /verbose [on|off]");
                    return;
                }
                await owner.Entry.SaveLane.CommitSettingsAsync(
                    new JsonObject { ["verbose"] = value == "on" },
                    runtime.Manager.Models
                );
                await source.Reply(
                    value == "on"
                        ? "✅ Verbose mode enabled. Tool calls will be shown."
                        : "✅ Verbose mode disabled. Tool calls will be hidden."
                );
                return;
        }
    }
}
