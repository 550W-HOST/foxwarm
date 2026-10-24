using Foxwarm.Channels.WebUi;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.Options;

namespace Foxwarm;

internal sealed class HttpResponseCompressionProvider(
    IServiceProvider services,
    IOptions<ResponseCompressionOptions> options
) : ResponseCompressionProvider(services, options)
{
    public override bool ShouldCompressResponse(HttpContext context)
    {
        // Decide at the first body write, after routing and response headers are available.
        // Raw transfers retain their original bytes and any known length for download progress.
        if (
            context.GetEndpoint()?.Metadata.GetMetadata<WebUiDownloadResource>() is not null
            || context.Response.Headers.ContainsKey("Content-Disposition")
            || Nodes.NodeBootstrap.IsPublicPath(context.Request.Path)
            || context.Request.Path == "/mcp"
            || context.WebSockets.IsWebSocketRequest
        )
            return false;

        // Native negotiation/MIME, Content-Encoding and Content-Range handling also covers
        // octet-stream Code file reads and already-compressed media, archives and fonts.
        return base.ShouldCompressResponse(context);
    }
}
