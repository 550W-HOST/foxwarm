using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm;

[JsonSerializable(typeof(JsonNode))]
[JsonSerializable(typeof(JsonObject))]
[JsonSerializable(typeof(JsonArray))]
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(bool))]
[JsonSerializable(typeof(byte))]
[JsonSerializable(typeof(short))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(long))]
[JsonSerializable(typeof(uint))]
[JsonSerializable(typeof(ulong))]
[JsonSerializable(typeof(float))]
[JsonSerializable(typeof(double))]
[JsonSerializable(typeof(decimal))]
[JsonSerializable(typeof(DateTime))]
[JsonSerializable(typeof(DateTimeOffset))]
[JsonSerializable(typeof(byte[]))]
[JsonSerializable(typeof(string[]))]
[JsonSerializable(typeof(VectorConfiguration))]
[JsonSerializable(typeof(VectorSearchOptions))]
[JsonSerializable(typeof(VectorSearchResult))]
[JsonSerializable(typeof(ArchiveBlockRecord))]
[JsonSerializable(typeof(LogWindow))]
[JsonSerializable(typeof(Microsoft.AspNetCore.Mvc.ProblemDetails))]
internal partial class MainJsonContext : JsonSerializerContext;
