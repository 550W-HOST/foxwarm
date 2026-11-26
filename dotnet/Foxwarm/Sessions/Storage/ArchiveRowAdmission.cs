using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>An admitted block with its JSON columns serialized once, outside any writer.</summary>
internal sealed record PreparedArchiveBlock(ArchiveBlockRecord Record, string? SourceIds, string? Facts);

/// <summary>
/// Current-shape admission of Archive rows for new writes and exact compensation, shared by
/// every Archive implementation. Historical reads use the more permissive
/// <see cref="ArchiveMessageRecord.FromStored"/>.
/// </summary>
internal static class ArchiveRowAdmission
{
    internal static ArchiveMessageRecord Message(ArchiveMessageRecord record, string sessionId)
    {
        if (
            record.SessionId != sessionId
            || record.Agent.Length == 0
            || record.Seq <= 0
            || !double.IsFinite(record.Timestamp)
            || record.Role is not ("user" or "model" or "tool")
        )
            throw new InvalidDataException(
                "Archive message record is outside the supported current shape."
            );
        var parsed = ArchiveMessageRecord.FromStored(
            record.SessionId,
            record.Agent,
            record.Seq,
            record.Timestamp,
            record.Role,
            record.MessageJson
        );
        // Historical readers accept row-owned metadata. New writes and exact
        // compensation retain the current-message admission contract.
        SessionAuthorityDocument.ValidateMessage(
            parsed.Message,
            checked((int)record.Seq),
            $"archive message {record.Seq}"
        );
        var innerTimestamp = SessionAuthorityDocument.ReadFiniteNumber(
            parsed.Message["__meta"]!["timestamp"]!,
            $"archive message {record.SessionId}#{record.Seq} timestamp"
        );
        if (innerTimestamp != record.Timestamp)
            throw new InvalidDataException(
                $"Archive message {record.SessionId}#{record.Seq} timestamp does not match message_json."
            );
        if (!JsonNode.DeepEquals(parsed.Message, record.Message))
            throw new InvalidDataException(
                "Archive message object does not match its raw message_json."
            );
        return parsed;
    }

    internal static void Block(ArchiveBlockRecord block, string expectedIdentity)
    {
        if (
            block.SessionId != expectedIdentity
            || block.Agent.Length == 0
            || block.Id <= 0
            || block.Level <= 0
            || block.SourceStart <= 0
            || block.SourceEnd <= 0
            || block.RawStartSeq <= 0
            || block.RawEndSeq < block.RawStartSeq
            || block.Summary.Trim().Length == 0
            || block.CreatedAt <= 0
            || block.FrictionScore is < 0 or > 100
            || block.SourceKind is not ("message" or "block")
            || block.SourceKind == "message"
                && (
                    block.Level != 1
                    || block.SourceStart != block.RawStartSeq
                    || block.SourceEnd != block.RawEndSeq
                )
            || block.SourceKind == "block"
                && (
                    block.Level <= 1
                    || (
                        block.SourceBlockIds is null
                            ? block.SourceStart > block.SourceEnd
                            : block.SourceBlockIds.Count == 0
                    )
                )
            || block.RawStartTimestamp is double start && !double.IsFinite(start)
            || block.RawEndTimestamp is double end && !double.IsFinite(end)
        )
            throw new InvalidDataException("Archive block is outside supported current shape.");
    }

    internal static PreparedArchiveBlock PrepareBlock(ArchiveBlockRecord block, string sessionId)
    {
        Block(block, sessionId);
        var owned = block with
        {
            SourceBlockIds = block.SourceBlockIds?.DeepClone() as JsonArray,
            MemoryFacts = block.MemoryFacts?.DeepClone() as JsonArray,
        };
        return new(owned, owned.SourceBlockIdsJson, owned.MemoryFactsJson);
    }
}
