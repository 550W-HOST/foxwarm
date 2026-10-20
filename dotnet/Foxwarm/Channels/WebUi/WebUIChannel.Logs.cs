using System.Globalization;
using System.Text.RegularExpressions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterLogRoutes(WebApplication app)
    {
        app.MapGet("/api/webui/logs", async (HttpRequest request) =>
        {
            try
            {
                var query = request.Query;
                if (query.Any(pair => pair.Key is not ("direction" or "offset" or "fileId" or "time") || pair.Value.Count != 1))
                    throw new InvalidDataException("Invalid log query.");
                var direction = query["direction"].ToString();
                var offset = query["offset"].ToString();
                var fileId = query["fileId"].ToString();
                var time = query["time"].ToString();
                if (time.Length > 0)
                {
                    if (fileId.Length == 0 || direction.Length > 0 || offset.Length > 0)
                        throw new InvalidDataException("Time lookup requires only a file identity and date/time.");
                    if (!DateTimeOffset.TryParse(time, CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
                        throw new InvalidDataException("Choose a valid date and time.");
                    return Results.Json(await logs.Seek(date.ToUnixTimeMilliseconds(), fileId));
                }
                if (direction.Length > 0 && direction is not ("latest" or "before" or "after"))
                    throw new InvalidDataException("Invalid log direction.");
                if (direction is "before" or "after" && (!query.ContainsKey("offset") || fileId.Length == 0))
                    throw new InvalidDataException("Log paging requires a file identity and byte position.");
                long? position = null;
                if (query.ContainsKey("offset"))
                {
                    if (!Regex.IsMatch(offset, @"^\d+$", RegexOptions.ECMAScript) || !long.TryParse(offset, out var number) || number > 9007199254740991L)
                        throw new InvalidDataException("Invalid log byte position.");
                    position = number;
                }
                return Results.Json(new { window = (await logs.Read(direction.Length == 0 ? "latest" : direction, position, fileId)).Json() });
            }
            catch (Exception error)
            {
                var reset = error is LogFileResetException;
                return Results.Json(new { error = error.Message, reset }, statusCode: reset ? 409 : 400);
            }
        });
    }
}
