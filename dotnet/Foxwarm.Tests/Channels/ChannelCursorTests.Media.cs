using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
namespace Foxwarm.Tests;

public sealed partial class ChannelCursorTests
{
    [Theory]
    [InlineData(400,1,2,2)]
    [InlineData(429,1,2,2)]
    [InlineData(503,1,2,2)]
    [InlineData(400,10,3,1)]
    [InlineData(503,10,3,1)]
    public async Task TelegramRetriesMediaAcrossPollsBeforeAdvancing(int code,int failures,int attempts,int queued)
    {
        await using var peer=await TelegramPeer.StartAsync();
        var cfg=ExternalChannelFixture.Channel();
        await using var f=await ExternalChannelFixture.CreateAsync(new(){["chat"]=cfg},dependencies:peer.Dependencies);
        f.Manager.AttachChannel("chat:42",f.Owner);
        var doc=TelegramPeer.Text("42","11",""); doc.Remove("text"); doc["message_id"]=31; doc["document"]=new JsonObject{["file_id"]="readme",["file_name"]="readme.txt",["mime_type"]="text/plain"};
        var good=TelegramPeer.Text("42","11","next message"); good["message_id"]=32;
        int requests=0;
        peer.Files["readme"]="restored attachment"u8.ToArray();
        peer.Respond=c=>{
            if(c.Method=="getFile" && Interlocked.Increment(ref requests)<=failures) return Task.FromResult<IResult?>(Results.Json(new {ok=false,error_code=code,description="Bad Request: wrong file_id or the file is temporarily unavailable"},statusCode:code));
            return Task.FromResult<IResult?>(c.Method=="getUpdates" && c.Body["offset"]?.ToString()=="0" ? Results.Json(new{ok=true,result=new[]{new{update_id=30,message=doc},new{update_id=31,message=good}}}):null);
        };
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Method=="getUpdates" && c.Body["offset"]?.ToString()=="32"));
        Assert.Equal(attempts,requests); Assert.Equal(queued,f.Owner.Entry.Snapshot().Queue.Count);
    }

    [Fact]
    public async Task MatrixSkipsAnInvalidDownloadedRasterWithoutLeavingFiles()
    {
        await using var p=await ExternalProtocolPeer.StartAsync();
        await using var f=await ExternalChannelFixture.CreateAsync(new(){["chat"]=p.Matrix()},dependencies:p.Dependencies);
        f.Manager.AttachChannel("chat:!room:fixture",f.Owner);
        p.Media["broken"]="not a JPEG"u8.ToArray(); int syncs=0;
        p.Respond=c=>{
            if (!c.Path.EndsWith("/sync")||c.Query.GetValueOrDefault("since")!="initial"||Interlocked.Increment(ref syncs)>3) return Task.FromResult<IResult?>(null);
            var bad=ExternalProtocolPeer.MatrixText("image","picture"); bad["content"]=new JsonObject{["msgtype"]="m.image",["body"]="photo.jpg",["url"]="mxc://fixture/broken",["info"]=new JsonObject{["mimetype"]="image/jpeg"}};
            var good=ExternalProtocolPeer.MatrixText("next","next message");
            return Task.FromResult<IResult?>(Results.Json(new{next_batch="done",rooms=new{join=new Dictionary<string,object>{["!room:fixture"]=new{timeline=new{events=new[]{bad,good}}}}}}));
        };
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(()=>p.Calls.Any(c=>c.Query.GetValueOrDefault("since")=="done"));
        Assert.Single(p.Calls,c=>c.Path.Contains("/download/"));
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        var files = Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files", "matrix");
        Assert.Empty(Directory.Exists(files) ? Directory.GetFiles(files) : []);
    }

    [Theory]
    [InlineData(1, 2, 2)]
    [InlineData(10, 3, 1)]
    public async Task MatrixMediaFetchesRetryAcrossSyncsAndLaterEventsProceed(int failures, int fetches, int inputs)
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["chat"] = peer.Matrix() }, dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("chat:!room:fixture", f.Owner);
        peer.Media["file"] = "recovered file"u8.ToArray();
        var file = ExternalProtocolPeer.MatrixText("file", "file");
        file["content"] = new JsonObject { ["msgtype"] = "m.file", ["url"] = "mxc://fixture/file", ["body"] = "file.txt" };
        var text = ExternalProtocolPeer.MatrixText("next", "later input");
        // This batch is created before initial startup, then delivered by the incremental sync.
        var timestamp = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        file["origin_server_ts"] = timestamp;
        text["origin_server_ts"] = timestamp;
        var timeline = new { events = new[] { file, text } };
        var join = new Dictionary<string, object> { ["!room:fixture"] = new { timeline } };
        int downloads = 0;
        peer.Respond = call =>
        {
            if (call.Path.Contains("/download/") && Interlocked.Increment(ref downloads) <= failures)
                return Task.FromResult<IResult?>(Results.StatusCode(503));
            return Task.FromResult<IResult?>(call.Path.EndsWith("/sync") && call.Query.GetValueOrDefault("since") == "initial"
                ? Results.Json(new { next_batch = "done", rooms = new { join } }) : null);
        };
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => peer.Calls.Any(c => c.Query.GetValueOrDefault("since") == "done"));
        Assert.Equal(fetches, downloads);
        Assert.Equal(inputs, f.Owner.Entry.Snapshot().Queue.Count);
    }

    [Fact]
    public async Task MatrixBlobStoreIntegrityFailureRetainsCursorUntilRepaired()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["chat"] = peer.Matrix() }, dependencies: peer.Dependencies
        );
        f.Manager.AttachChannel("chat:!room:fixture", f.Owner);
        var bytes = TelegramChannelTests.Jpeg();
        peer.Media["photo"] = bytes;
        // The content-addressed store has a bad copy of a valid wire image. This is a
        // storage failure on verification, never an invalid event to acknowledge.
        var key = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)) + ".jpg";
        var path = new Foxwarm.Images.ImageBlobFiles(f.Data).PathFor(key);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "corrupt incumbent");
        var image = ExternalProtocolPeer.MatrixText("image", "photo");
        image["origin_server_ts"] = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        image["content"] = new JsonObject
        {
            ["msgtype"] = "m.image", ["body"] = "photo.jpg", ["url"] = "mxc://fixture/photo",
            ["info"] = new JsonObject { ["mimetype"] = "image/jpeg" },
        };
        var timeline = new { events = new[] { image } };
        var join = new Dictionary<string, object> { ["!room:fixture"] = new { timeline } };
        int attempts = 0;
        var repair = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        string? Error() => f.Manager.ManagedChannels!.Statuses().OfType<JsonObject>()
            .Single(row => row["channelId"]!.ToString() == "chat")["lastError"]?.ToString();
        peer.Respond = async call =>
        {
            if (!call.Path.EndsWith("/sync") || call.Query.GetValueOrDefault("since") != "initial")
                return null;
            if (Interlocked.Increment(ref attempts) == 5)
            {
                await repair.Task;
                File.Delete(path);
            }
            return Results.Json(new { next_batch = "done", rooms = new { join } });
        };
        await f.Manager.ManagedChannels!.ReloadAsync();
        try
        {
            await TelegramChannelTests.Until(() => Volatile.Read(ref attempts) == 5);
            Assert.Equal("Matrix input is paused: an incoming message couldn't be saved. Retrying.", Error());
            Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        }
        finally { repair.TrySetResult(); }
        await TelegramChannelTests.Until(() => peer.Calls.Any(c => c.Query.GetValueOrDefault("since") == "done"));
        Assert.Null(Error());
        Assert.Equal(5, attempts);
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        Assert.Single(Directory.GetFiles(Path.Combine(f.Manager.AgentDirectory("main"), ".temp", "channel-files", "matrix")));
    }

    [Fact]
    public async Task GuestPolicyRefusalRepliesAndAllowsLaterAuthorizedInput()
    {
        await using var p=await TelegramPeer.StartAsync(); var cfg=ExternalChannelFixture.Channel(); cfg["guestAgent"]=new JsonObject{["agentId"]="guest"};
        await using var f=await ExternalChannelFixture.CreateAsync(new(){["chat"]=cfg},dependencies:p.Dependencies);
        await f.Manager.CreateAgentAsync("guest",createMainSession:false); f.Manager.AttachChannel("chat:42",f.Owner);
        var ignored=TelegramPeer.Text("43","999","unbound guest"); ignored["message_id"]=31;
        var good=TelegramPeer.Text("42","11","normal authorized message"); good["message_id"]=32;
        int pulls=0; p.Respond=c=>Task.FromResult<IResult?>(c.Method=="getUpdates"&&c.Body["offset"]?.ToString()=="0" && Interlocked.Increment(ref pulls)<=3 ? Results.Json(new{ok=true,result=new[]{new{update_id=30,message=ignored},new{update_id=31,message=good}}}):null);
        await f.Manager.ManagedChannels!.ReloadAsync(); await TelegramChannelTests.Until(()=>p.Calls.Any(c=>c.Method=="getUpdates" && c.Body["offset"]?.ToString()=="32"));
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
        await TelegramChannelTests.Until(()=>p.Sent("a").Any(c=>c.Body["chat_id"]?.ToString()=="43"));
        Assert.Null(f.Manager.ChannelBinding("chat:43"));
    }

    [Fact]
    public async Task TelegramEditedMessageIsCheckpointedButNeverAdmitted()
    {
        await using var p=await TelegramPeer.StartAsync(); await using var f=await ExternalChannelFixture.CreateAsync(new(){["chat"]=ExternalChannelFixture.Channel()},dependencies:p.Dependencies); f.Manager.AttachChannel("chat:42",f.Owner);
        var msg=TelegramPeer.Text("42","11","original"); msg["message_id"]=8; var edit=(JsonObject)msg.DeepClone();edit["text"]="edited";
        p.Respond=c=>Task.FromResult<IResult?>(c.Method=="getUpdates"&&c.Body["offset"]?.ToString()=="0" ? Results.Json(new{ok=true,result=new object[]{new{update_id=1,message=msg},new{update_id=2,edited_message=edit}}}):null);
        await f.Manager.ManagedChannels!.ReloadAsync(); await TelegramChannelTests.Until(()=>p.Calls.Any(c=>c.Method=="getUpdates"&&c.Body["offset"]?.ToString()=="3")); Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }
}
