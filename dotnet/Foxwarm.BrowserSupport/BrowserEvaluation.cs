using System.Text.Json;
using PuppeteerSharp;
using PuppeteerSharp.Cdp;
using PuppeteerSharp.Cdp.Messaging;

namespace Foxwarm.BrowserSupport;

internal static class BrowserEvaluation
{
    // Preserve Puppeteer's return-by-value clone before JavaScript JSON.stringify.
    // Directly stringifying the live handle would call Date.toJSON and differ from Source.
    internal static async Task<string> StringifyResult(IJSHandle value)
    {
        var remote = ((ICdpHandle)value).RemoteObject;
        if (remote.Type == RemoteObjectType.Undefined)
            return "undefined";
        if (remote.Type == RemoteObjectType.Bigint)
            throw new InvalidDataException("Do not know how to serialize a BigInt");
        if (remote.UnserializableValue is not null)
            return remote.UnserializableValue == "-0" ? "0" : "null";
        JsonElement? cloned;
        try
        {
            cloned = await value.JsonValueAsync<JsonElement?>();
        }
        catch (PuppeteerException error)
            when (error.Message.Contains(
                    "Could not serialize referenced object",
                    StringComparison.Ordinal
                )
            )
        {
            return "undefined";
        }
        if (cloned is null)
            return "null";
        return BrowserCloneJson.Stringify(cloned.Value);
    }

}
