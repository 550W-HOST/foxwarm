using System.Globalization;
using System.Text;

namespace Foxwarm.CliNode;

// A CLI-local BCL adapter, independent of the optional remote terminal service.
internal static class ConsoleNode
{
    internal static async Task Run(NodeClientOptions options, InteractiveOptions interactive, CancellationToken stop)
    {
        using var state = new InteractiveNode(interactive);
        var inputEncoding = Console.InputEncoding;
        var outputEncoding = Console.OutputEncoding;
        var controlC = Console.TreatControlCAsInput;
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop);
        Task? running = null;
        try
        {
            try
            {
                _ = Console.KeyAvailable;
            }
            catch (InvalidOperationException)
            {
                throw new InvalidDataException("--interactive needs console input; use the headless entry for redirected input");
            }
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;
            Console.TreatControlCAsInput = true;
            var client = new NodeClient(options with { ToolCallInterceptor = state.Intercept, OnStatus = state.Status }, new NodePaths(Environment.CurrentDirectory));
            state.Attach(client);
            running = client.Run(lifetime.Token);
            var nextRefresh = DateTime.UtcNow;
            long drawn = -1;
            var size = (Width: 0, Height: 0);
            while (!lifetime.IsCancellationRequested && !running.IsCompleted)
            {
                if (Console.KeyAvailable)
                {
                    var batch = new List<ConsoleKeyInfo>();
                    do
                    {
                        batch.Add(Console.ReadKey(intercept: true));
                    } while (Console.KeyAvailable);
                    if (!state.Input(batch))
                        break;
                }
                if (DateTime.UtcNow >= nextRefresh)
                {
                    state.Refresh();
                    nextRefresh = DateTime.UtcNow.AddSeconds(3);
                }
                var view = state.View(options.Host);
                var width = Console.WindowWidth;
                var height = Console.WindowHeight;
                var currentSize = (Width: width > 0 ? Math.Max(20, width) : 80, Height: height > 0 ? Math.Max(8, height) : 24);
                if (drawn != view.Version || currentSize != size)
                {
                    Draw(view.Lines, currentSize.Width, currentSize.Height);
                    drawn = view.Version;
                    size = currentSize;
                }
                await Task.Delay(20, CancellationToken.None);
            }
        }
        finally
        {
            state.Dispose();
            lifetime.Cancel();
            try
            {
                if (running is not null)
                    await running;
            }
            finally
            {
                Console.TreatControlCAsInput = controlC;
                Console.InputEncoding = inputEncoding;
                Console.OutputEncoding = outputEncoding;
                Console.WriteLine();
            }
        }
    }

    private static void Draw(IReadOnlyList<string> lines, int width, int height)
    {
        // Keep the action/draft rows visible in a short terminal; do not interpret payload escapes.
        var shown = lines.Count < height ? lines : lines.Take(2).Concat(lines.Skip(Math.Max(2, lines.Count - height + 3))).ToArray();
        var text = string.Join(Environment.NewLine, shown.Select(line => Text(line, width - 1)));
        if (!Console.IsOutputRedirected)
            Console.Write("\u001b[H\u001b[2J");
        Console.Write(text + Environment.NewLine);
    }

    internal static string Text(string text, int limit)
    {
        var safe = new StringBuilder();
        foreach (var rune in text.EnumerateRunes())
        {
            if (Rune.IsControl(rune) || rune.Value is 0x2028 or 0x2029)
                safe.Append(rune.Value switch
                {
                    10 => "\\n",
                    13 => "\\r",
                    9 => "\\t",
                    _ => "\\u" + rune.Value.ToString("x4", CultureInfo.InvariantCulture),
                });
            else
                safe.Append(rune.ToString());
        }
        var value = safe.ToString();
        if (value.Length <= limit)
            return value;
        var end = limit;
        if (end > 0 && char.IsHighSurrogate(value[end - 1]))
            end--;
        return value[..end] + "…";
    }
}
