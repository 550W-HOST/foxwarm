namespace Foxwarm.Net;

internal static class BoundedResponse
{
    internal const int ErrorBytes = 1024 * 1024;
    internal const int JsonBytes = 8 * 1024 * 1024;

    // Callers use ResponseHeadersRead. Buffering here retains the content charset/BOM
    // rules and enforces the limit even for chunked or decoded content of unknown length.
    internal static async Task<string> ReadTextAsync(HttpContent content, int bytes, string service, CancellationToken token)
    {
        try { await content.LoadIntoBufferAsync(bytes, token).ConfigureAwait(false); }
        catch (HttpRequestException error) when (error.HttpRequestError == HttpRequestError.ConfigurationLimitExceeded)
        {
            throw TooLarge(service, "body", bytes, error);
        }
        return await content.ReadAsStringAsync(token).ConfigureAwait(false);
    }
    internal static InvalidDataException TooLarge(string service, string portion, int limit, Exception? cause = null)
    {
        MainLog.Diagnostic($"{service} response {portion} exceeds {limit} decoded bytes.", failure: true);
        return new InvalidDataException(service == "model" ? "The model's response was too large to process."
            : $"The response from {service} was too large to process.", cause);
    }

}
