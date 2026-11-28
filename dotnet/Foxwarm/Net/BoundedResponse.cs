namespace Foxwarm.Net;

internal static class BoundedResponse
{
    internal const int ErrorBytes = 1024 * 1024;
    internal const int JsonBytes = 8 * 1024 * 1024;

    // Callers use ResponseHeadersRead. Buffering here retains the content charset/BOM
    // rules and enforces the limit even for chunked or decoded content of unknown length.
    internal static async Task<string> ReadTextAsync(HttpContent content, int bytes, CancellationToken token)
    {
        try { await content.LoadIntoBufferAsync(bytes, token).ConfigureAwait(false); }
        catch (HttpRequestException error) when (error.HttpRequestError == HttpRequestError.ConfigurationLimitExceeded)
        {
            throw new InvalidDataException("Response exceeds the size limit.", error);
        }
        return await content.ReadAsStringAsync(token).ConfigureAwait(false);
    }
}
