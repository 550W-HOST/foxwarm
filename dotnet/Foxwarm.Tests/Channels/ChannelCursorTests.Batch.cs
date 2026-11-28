using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class ChannelCursorTests
{
    [Fact]
    public async Task TelegramAcceptsLowerUpdateIdsAfterAnIdlePeriod()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["chat"] = ExternalChannelFixture.Channel() },dependencies:peer.Dependencies);
        f.Manager.AttachChannel("chat:42",f.Owner);
        var ck = new ChannelCursors(new FileStateDocuments(f.Data));
        await ck.SaveAsync("chat","telegram:500",new(){["offset"]=1000});
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Method=="getUpdates" && c.Body["offset"]!.ToString()=="1000"));
        var fresh = TelegramPeer.Text("42","11","after quiet interval");
        fresh["message_id"] = 811;
        peer.Push("a", fresh);
        await TelegramChannelTests.Until(()=>peer.Calls.Count(c=>c.Method=="getUpdates" && c.Body["offset"]!.ToString()=="2") >= 1);
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }

    [Fact]
    public async Task TelegramReceiptUsesChatAndMessageAcrossAnUpdateIdReset()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new() { ["chat"] = ExternalChannelFixture.Channel() }, dependencies:peer.Dependencies);
        f.Manager.AttachChannel("chat:42", f.Owner);
        f.Manager.AttachChannel("chat:43", f.Owner);
        JsonObject Message(string chat, int number, string body)
        {
            var message = TelegramPeer.Text(chat, "11", body);
            message["message_id"] = number;
            return message;
        }
        var batch = new[]
        {
            new { update_id=10, message=Message("42", 123, "first") },
            new { update_id=10, message=Message("42", 124, "after ID reset") },
            new { update_id=11, message=Message("43", 124, "other chat") },
            new { update_id=12, message=Message("42", 124, "same message replayed") },
        };
        peer.Respond = c => Task.FromResult<IResult?>(c.Method == "getUpdates" && c.Body["offset"]?.ToString() == "0"
            ? Results.Json(new { ok=true, result=batch }) : null);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Method=="getUpdates" && c.Body["offset"]?.ToString()=="13"));
        var queued = f.Owner.Entry.Snapshot().Queue.Select(item=>SessionQueueJson.ToJson(item).ToJsonString()).ToArray();
        Assert.Equal(3, queued.Length);
        Assert.DoesNotContain(queued, text=>text.Contains("same message replayed"));
    }

    [Fact]
    public async Task MatrixSkipsRejectedMediaAndAdmitsLaterInput()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new(){["chat"]=peer.Matrix()},dependencies:peer.Dependencies);
        f.Manager.AttachChannel("chat:!room:fixture",f.Owner);
        int reads=0;
        peer.Respond = call => {
            if (!call.Path.EndsWith("/sync") || call.Query.GetValueOrDefault("since")!="initial" || Interlocked.Increment(ref reads)>4) return Task.FromResult<IResult?>(null);
            var bad=ExternalProtocolPeer.MatrixText("file","discard"); bad["content"] = new JsonObject { ["msgtype"]="m.file", ["url"]="https://invalid.example/a" };
            var good=ExternalProtocolPeer.MatrixText("useful","later ordinary message");
            return Task.FromResult<IResult?>(Results.Json(new { next_batch="next", rooms=new { join = new Dictionary<string,object> { ["!room:fixture"]=new { timeline=new { events=new[]{bad,good} } } } } }));
        };
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Query.GetValueOrDefault("since")=="next"));
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }

    [Theory]
    [InlineData("restart")]
    [InlineData("stop")]
    public async Task WeixinCommandsCanReplaceThenRetireASuccessorInTheSameBatch(string second)
    {
        await using var peer=await ExternalProtocolPeer.StartAsync();
        var f=await ExternalChannelFixture.CreateAsync(new(){["chat"]=peer.Weixin()},dependencies:peer.Dependencies);
        await f.Manager.ManagedChannels!.ReloadAsync();
        peer.WeixinMessages("weixin-a",ExternalProtocolPeer.WeixinText("alice","/channel restart chat"),ExternalProtocolPeer.WeixinText("alice","/channel " + second + " chat"));
        await TelegramChannelTests.Until(()=>peer.Sent("weixin-a").Length==2);
        var path = Path.Combine(f.Data,"state","channel-cursors.json");
        await TelegramChannelTests.Until(()=>File.Exists(path) && File.ReadAllText(path).Contains("cursor-1"));
        if (second == "restart")
            await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Body["get_updates_buf"]?.ToString()=="cursor-1"));
        else Assert.Null(f.Manager.ChannelRegistry.Get("chat"));
        await f.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task TelegramSkipsRejectedMediaAndContinuesTheBatch()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new(){["chat"]=ExternalChannelFixture.Channel()},dependencies:peer.Dependencies);
        f.Manager.AttachChannel("chat:42",f.Owner);
        var bad=TelegramPeer.Text("42","11","");
        bad.Remove("text"); bad["document"]=new JsonObject();
        var good=TelegramPeer.Text("42","11","next message");
        peer.Respond=call=>Task.FromResult<IResult?>(call.Method=="getUpdates" && call.Body["offset"]?.ToString()=="0"
            ? Results.Json(new {ok=true,result=new[]{new{update_id=1,message=bad},new{update_id=2,message=good}}}) : null);
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Method=="getUpdates" && c.Body["offset"]?.ToString()=="3"));
        Assert.Single(f.Owner.Entry.Snapshot().Queue);
    }
}
