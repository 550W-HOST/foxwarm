using System.Net;
using Xunit;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// The S3 fixture starts and refuses unauthenticated requests. Object operations are covered
/// by the blob store's contract suite, which brings the S3 client.
/// </summary>
[Trait("Backend", "s3")]
public sealed class S3ServerTests
{
    [Fact]
    public async Task TheGatewayServesAndRequiresSignedRequests()
    {
        var server = await S3Server.SharedAsync();
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false });
        using var response = await http.GetAsync(new Uri(server.Endpoint, "/" + S3Server.NewBucketName()));
        // Refused with an S3 error document, never served.
        Assert.Contains(response.StatusCode, new[] { HttpStatusCode.Forbidden, HttpStatusCode.NotFound });
        Assert.Contains("<Error>", await response.Content.ReadAsStringAsync());
        Assert.NotEqual(S3Server.NewBucketName(), S3Server.NewBucketName());
    }
}
