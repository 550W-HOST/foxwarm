using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WebUiAdjacentProjectionTests
{
    [Fact]
    public async Task Accepted_passive_peer_task_and_system_inputs_have_ordered_HTTP_previews_without_consumption()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var source = await f.Manager.CreateNamedAsync("main", "preview-source", null, null);
        var target = await f.Manager.CreateNamedAsync("main", "preview-target", null, null);
        var triggers = 0;
        target.Registry.TriggerOverride = _ => { triggers++; return Task.CompletedTask; };
        await f.Manager.SendAsync(source, target.Id, "accepted passive peer", trigger: false);
        var first = (await f.Admin.GetFromJsonAsync<JsonObject>("api/sessions/preview-target/history"))!;
        Assert.Equal(1, first["queueLength"]!.GetValue<int>());
        Assert.Single(first["queuedMessages"]!.AsArray());
        Assert.Equal(0, triggers);
        await f.Manager.SendTaskNotificationAsync(null, target.Id, "accepted user task", false, "task-test", "assigned", "new");
        await new SessionRuntime(f.Manager).QueueTriggerAsync(target.Id, "accepted trigger");
        foreach (var type in new[] { "background", "onboot" })
            await f.Manager.AdmitNodeSessionEventAsync("master", new JsonObject
            {
                ["sessionId"] = target.Id,
                ["eventType"] = type,
                ["message"] = SessionBoundary.SessionEvent(type, "accepted " + type),
            });
        var before = await target.AuthorityStore.LoadAsync(target.Id);
        var canonicalQueue = before!.Queue.Select(PersistentSessionAuthorityStore.ToQueueJson).ToArray();
        var history = (await f.Admin.GetFromJsonAsync<JsonObject>("api/sessions/preview-target/history"))!;
        var previews = history["queuedMessages"]!.AsArray();
        Assert.Equal(5, history["queueLength"]!.GetValue<int>());
        Assert.Equal(0, history["queuedPreviewOmittedCount"]!.GetValue<int>());
        Assert.Equal(new[] { "intersession", "intersession", "trigger", "background", "onboot" },
            previews.Select(row => row!["__meta"]!["queueType"]!.GetValue<string>()));
        Assert.Equal(Enumerable.Range(0, 5), previews.Select(row => row!["__meta"]!["queueIndex"]!.GetValue<int>()));
        for (var i = 0; i < previews.Count; i++)
        {
            Assert.True(previews[i]!["__meta"]!["temporary"]!.GetValue<bool>());
            Assert.True(previews[i]!["__meta"]!["queuedPreview"]!.GetValue<bool>());
            Assert.Equal(before.Queue[i].Parts![0]["system"]!.GetValue<string>(), previews[i]!["parts"]![0]!["system"]!.GetValue<string>());
        }
        Assert.Contains("type=\"inter-agent\"", previews[0]!["parts"]![0]!["system"]!.GetValue<string>());
        Assert.Contains("sourceKind=\"user\"", previews[1]!["parts"]![0]!["system"]!.GetValue<string>());
        Assert.False(before.Queue[0].Trigger);
        Assert.False(before.Queue[1].Trigger);
        Assert.Equal(3, triggers);
        Assert.Empty(history["messages"]!.AsArray());
        Assert.Empty(target.Archive.ReadMessages());
        foreach (var actual in new[] { target.Entry.Snapshot(), (await target.AuthorityStore.LoadAsync(target.Id))! })
            Assert.True(JsonNode.DeepEquals(new JsonArray(canonicalQueue.Select(item => item.DeepClone()).ToArray()), new JsonArray(actual.Queue.Select(item => (JsonNode?)PersistentSessionAuthorityStore.ToQueueJson(item)).ToArray())));
    }

    [Fact]
    public void Non_user_fallback_and_prebuilt_previews_preserve_wrappers_metadata_bounds_and_control_exclusions()
    {
        var state = new SessionState("preview");
        state.Queue.Add(new QueueItem(QueueItemType.CompactCommit));
        state.Queue.Add(new QueueItem(QueueItemType.Wait, [new JsonObject { ["text"] = "internal control" }]));
        state.Queue.Add(new QueueItem(QueueItemType.Background, [new JsonObject { ["text"] = new string('x', 9000) }], SourceSessionId: "source&peer"));
        state.Queue.Add(new QueueItem(QueueItemType.OnBoot, Message: JsonNode.Parse("""{"role":"model","parts":[{"system":"existing wrapper","other":{"system":"nested application data"}}],"__meta":{"retained":"prebuilt"}}""")!.AsObject()));
        state.Queue.Add(new QueueItem(QueueItemType.User, [new JsonObject { ["inlineDataRef"] = new JsonObject { ["blobId"] = "fixture-blob", ["mimeType"] = "image/png" } }]));
        for (var i = 0; i < 21; i++)
            state.Queue.Add(new QueueItem(QueueItemType.Trigger, [new JsonObject { ["system"] = "event " + i }]));
        var preview = WebUiContract.QueuedPreview(state.Snapshot());
        Assert.Equal(20, preview.Count);
        var fallback = preview[0]!["parts"]![0]!["system"]!.GetValue<string>();
        Assert.StartsWith("<foxwarm-message type=\"background\" sourceSessionId=\"source&amp;peer\" hint=\"queued session event preview\">\n", fallback);
        Assert.EndsWith("\n</foxwarm-message>", fallback);
        Assert.Contains(new string('x', 4000) + "\n… [preview truncated]", fallback);
        Assert.DoesNotContain(new string('x', 4001), fallback);
        Assert.Equal(2, preview[0]!["__meta"]!["queueIndex"]!.GetValue<int>());
        Assert.Equal("model", preview[1]!["role"]!.GetValue<string>());
        Assert.Equal("prebuilt", preview[1]!["__meta"]!["retained"]!.GetValue<string>());
        Assert.Equal("existing wrapper", preview[1]!["parts"]![0]!["system"]!.GetValue<string>());
        Assert.Equal("nested application data", preview[1]!["parts"]![0]!["other"]!["system"]!.GetValue<string>());
        Assert.Equal("[image/png attachment preview omitted]", preview[2]!["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Null(preview[2]!["parts"]![0]!["inlineDataRef"]);
        Assert.Equal("fixture-blob", state.Queue[4].Parts![0]["inlineDataRef"]!["blobId"]!.GetValue<string>());
        Assert.Equal(9000, state.Queue[2].Parts![0]["text"]!.GetValue<string>().Length);
        Assert.Empty(state.History);
    }

    [Fact]
    public async Task Debug_bounds_real_queued_input_fields_but_retains_nested_data_prebuilt_messages_and_authority()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "debug-bounds", null, null);
        target.Registry.TriggerOverride = _ => Task.CompletedTask;
        var longText = new string('x', 9000);
        using var accepted = await f.Admin.PostAsJsonAsync("api/sessions/debug-bounds/message", new { text = longText });
        Assert.True(accepted.IsSuccessStatusCode, await accepted.Content.ReadAsStringAsync());
        await target.Registry.Ingress.EnqueueAsync(target.Id, new QueueItem(QueueItemType.User,
        [new JsonObject
        {
            ["text"] = longText, ["system"] = longText, ["thinking"] = longText,
            ["functionResponse"] = new JsonObject { ["response"] = new JsonObject { ["text"] = longText, ["system"] = longText, ["thinking"] = longText } },
            ["functionCall"] = new JsonObject { ["args"] = new JsonObject { ["text"] = longText } },
        }]));
        await target.Registry.Ingress.EnqueueAsync(target.Id, QueueItem.Prebuilt(new JsonObject
        {
            ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = longText }),
        }));
        var authority = await File.ReadAllTextAsync(Path.Combine(f.Manager.DataRoot, "state", "sessions", target.Id + ".json"));
        var debug = (await f.Admin.GetFromJsonAsync<JsonObject>("api/sessions/debug-bounds/debug-file"))!["payload"]!;
        var queue = debug["queue"]!;
        var history = (await f.Admin.GetFromJsonAsync<JsonObject>("api/sessions/debug-bounds/history"))!;
        Assert.Equal(history["queuedMessages"]![0]!["parts"]![0]!["system"]!.GetValue<string>(), queue[0]!["parts"]![0]!["system"]!.GetValue<string>());
        Assert.Equal(4022, queue[0]!["parts"]![0]!["system"]!.GetValue<string>().Length);
        foreach (var field in new[] { "text", "system", "thinking" })
        {
            Assert.Equal(longText[..4000] + "\n… [preview truncated]", queue[1]!["parts"]![0]![field]!.GetValue<string>());
            Assert.Equal(longText, queue[1]!["parts"]![0]!["functionResponse"]!["response"]![field]!.GetValue<string>());
        }
        Assert.Equal(longText, queue[1]!["parts"]![0]!["functionCall"]!["args"]!["text"]!.GetValue<string>());
        Assert.Equal(longText, queue[2]!["message"]!["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Equal(authority, await File.ReadAllTextAsync(Path.Combine(f.Manager.DataRoot, "state", "sessions", target.Id + ".json")));
        Assert.Empty(target.History());
    }

    internal static JsonObject HostedMessage()
    {
        return ResponsesCanonicalConverter.ConvertAssistant(JsonNode.Parse("""
            {"output":[
              {"type":"web_search_call","id":"search-id","status":"completed","action":{"type":"search","query":"visible query","queries":["first",17,"second"],"sources":[{"url":"https://example.com/replay","text":"replay source body"}],"extra":"replay action"},"extra":"replay item"},
              {"type":"web_search_call","id":"open-id","action":{"type":"open_page","url":"https://example.com/display","sources":["replay"]}},
              {"type":"web_search_call","id":"unknown-id","action":{"type":"find","pattern":"replay find"}},
              {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Cited answer","annotations":[{"type":"url_citation","url":"https://example.com/cited","title":"Kept citation"}]}]},
              {"type":"reasoning","summary":[{"text":"visible reasoning"}],"encrypted_content":"opaque-😀"}
            ]}
            """)!.AsObject(), "fixture/model", 1000, 10)!;
    }

    internal static void AssertHostedDisplay(JsonObject message)
    {
        var parts = message["parts"]!;
        var search = parts[0]!["providerMeta"]!["openaiResponses"]!;
        Assert.Equal("fixture/model", search["sourceModelId"]!.GetValue<string>());
        Assert.Equal("""{"type":"web_search_call","action":{"type":"search","query":"visible query","queries":["first","second"]}}""", search["outputItem"]!.ToJsonString());
        var open = parts[1]!["providerMeta"]!["openaiResponses"]!["outputItem"]!;
        Assert.Equal("""{"type":"web_search_call","action":{"type":"open_page","url":"https://example.com/display"}}""", open.ToJsonString());
        Assert.Null(parts[2]!["providerMeta"]!["openaiResponses"]!["outputItem"]);
        Assert.Equal("Kept citation", parts[3]!["providerMeta"]!["openaiResponses"]!["annotations"]![0]!["title"]!.GetValue<string>());
        Assert.Equal("visible reasoning", parts[4]!["thinking"]!.GetValue<string>());
        Assert.Equal("opaque-😀".Length, parts[4]!["providerMeta"]!["encryptedThinkingLength"]!.GetValue<int>());
    }

    [Fact]
    public void Hosted_display_allowlist_caps_string_queries_without_touching_other_metadata_or_nested_results()
    {
        var message = WebUiMessageTransportTests.Message();
        var hosted = message["parts"]![4]!["providerMeta"]!["openaiResponses"]!.AsObject();
        hosted["annotations"] = new JsonArray(new JsonObject { ["type"] = "url_citation", ["url"] = "https://example.com/" });
        hosted["replayOnly"] = "remove known hosted replay";
        var queries = new JsonArray(Enumerable.Range(0, 25).Select(index => (JsonNode?)JsonValue.Create("query " + index)).ToArray());
        queries.Insert(1, JsonValue.Create(17));
        hosted["outputItem"]!["action"]!["queries"] = queries;
        hosted["outputItem"]!["action"]!["sources"] = new JsonArray("replay source");
        message["parts"]![8]!["functionResponse"]!["response"]!["hostedData"] = new JsonObject { ["outputItem"] = new JsonObject { ["type"] = "web_search_call", ["action"] = new JsonObject { ["sources"] = new JsonArray("nested business source") } } };
        var before = message.ToJsonString();
        var display = (JsonObject)message.DeepClone();
        WebUiMessageTransport.ProjectHistoryViewerMessage(display);
        WebUiMessageTransportTests.AssertProjected(display);
        var result = display["parts"]![4]!["providerMeta"]!["openaiResponses"]!;
        Assert.Null(result["replayOnly"]);
        Assert.NotNull(result["annotations"]);
        Assert.Null(result["outputItem"]!["action"]!["sources"]);
        Assert.Equal(Enumerable.Range(0, 20).Select(index => "query " + index), result["outputItem"]!["action"]!["queries"]!.AsArray().Select(value => value!.GetValue<string>()));
        Assert.Equal("nested business source", display["parts"]![8]!["functionResponse"]!["response"]!["hostedData"]!["outputItem"]!["action"]!["sources"]![0]!.GetValue<string>());
        Assert.Equal(before, message.ToJsonString());
    }

    [Fact]
    public async Task Converted_hosted_replay_is_narrowed_only_in_exact_and_paged_History_viewer_HTTP()
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "hosted-display", null, null);
        var canonical = HostedMessage();
        await ForkClearLifecycleTests.AppendAsync(target, new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "preceding input" }) }, canonical);
        var archive = target.Archive.ReadMessages().Last().MessageJson;
        var saved = target.History().Last().ToJsonString();
        foreach (var suffix in new[] { "target=msg%232", "afterSeq=1", "beforeSeq=3" })
        {
            var result = (await f.Admin.GetFromJsonAsync<JsonObject>("api/history/window?sessionId=hosted-display&" + suffix))!;
            AssertHostedDisplay(result["messages"]!.AsArray().Last()!.AsObject());
        }
        foreach (var route in new[] { "history", "history/continuous", "archive/messages/2", "debug-file" })
        {
            var result = (await f.Admin.GetFromJsonAsync<JsonObject>("api/sessions/hosted-display/" + route))!;
            var message = route == "archive/messages/2" ? result["message"]! : route == "debug-file" ? result["payload"]!["history"]!.AsArray().Last()! : result["messages"]!.AsArray().Last()!;
            Assert.Equal("replay source body", message["parts"]![0]!["providerMeta"]!["openaiResponses"]!["outputItem"]!["action"]!["sources"]![0]!["text"]!.GetValue<string>());
        }
        Assert.Equal(archive, target.Archive.ReadMessages().Last().MessageJson);
        Assert.Equal(saved, target.History().Last().ToJsonString());
        var replay = ResponsesRequestSerializer.BuildRequest(target.History(), "model", "fixture/model", "", 100);
        Assert.Contains("replay source body", replay.ToJsonString());
        Assert.Contains("opaque-", replay.ToJsonString());
    }
}
