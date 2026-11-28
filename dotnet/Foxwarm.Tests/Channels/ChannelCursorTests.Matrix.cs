using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class ChannelCursorTests
{
    [Fact]
    public async Task ReplacementSenderUsesEncryptionRecordedAfterSelfRestart()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(new(){["chat"]=peer.Matrix()},dependencies:peer.Dependencies);
        var firstRules=0; var hold=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond=async c => { if(c.Path.EndsWith("/pushrules/") && Interlocked.Increment(ref firstRules)==2) await hold.Task; return null; };
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(()=>peer.Calls.Any(c=>c.Query.GetValueOrDefault("since")=="initial"));
        var initial=f.Manager.ChannelRegistry.Get("chat");
        peer.MatrixEvents("matrix-a","!room:fixture",ExternalProtocolPeer.MatrixText("cmd","/channel restart chat"),new JsonObject{["type"]="m.room.encryption",["state_key"]="",["content"]=new JsonObject()});
        try
        {
            await TelegramChannelTests.Until(()=>Volatile.Read(ref firstRules)==2);
            var file=Path.Combine(f.Data,"state","channel-cursors.json");
            await TelegramChannelTests.Until(()=>File.ReadAllText(file).Contains("cursor-1"));
            Assert.Contains("!room:fixture",File.ReadAllText(file));
            var sender=f.Manager.ChannelRegistry.Get("chat")!; Assert.NotSame(initial,sender);
            // A canceled token makes a network send impossible. The encryption guard in SendEventAsync precedes cancellation.
            var err=await Record.ExceptionAsync(()=>sender.Send("!room:fixture","",new(),new CancellationToken(true)));
            Assert.Contains("encryption",Assert.IsType<InvalidOperationException>(err).Message);
        }
        finally {hold.TrySetResult();}
    }
}
