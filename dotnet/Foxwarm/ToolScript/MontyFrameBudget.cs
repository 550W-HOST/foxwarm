using Google.Protobuf;
using Google.Protobuf.Reflection;
using Monty.V1;

namespace Foxwarm.ToolScript;

/// <summary>Budget pass for the fixed Monty protocol, before standard generated materialization.</summary>
internal static class MontyFrameBudget
{
    internal const int MaximumFrame = 256 * 1024 * 1024;
    internal const int ProtocolDepth = 100;
    private static readonly MessageParser<ChildEvent> Parser = ChildEvent.Parser.WithDiscardUnknownFields(true);
    internal static ChildEvent Parse(byte[] frame, ToolScriptDataBudget budget, bool frameReserved = false)
    {
        Preflight(frame, budget, frameReserved);
        return Parser.ParseFrom(frame);
    }
    internal static void Preflight(byte[] frame, ToolScriptDataBudget budget, bool frameReserved = false)
    {
        if (frame.Length > MaximumFrame) throw new InvalidDataException("Monty frame exceeds 256 MiB.");
        // Input frame plus the fixed-size generated/semantic representations. No unknown-field objects.
        if (!frameReserved) budget.Charge(frame.Length);
        using var input = new CodedInputStream(frame);
        Message(input, frame, frame.Length, ChildEvent.Descriptor, budget, 0);
        if (!input.IsAtEnd) throw new InvalidDataException("Unexpected Monty frame tail.");
    }
    private static void Message(CodedInputStream input, byte[] frame, long end, MessageDescriptor schema, ToolScriptDataBudget budget, int depth)
    {
        if (depth >= ProtocolDepth) throw new InvalidDataException("Monty protocol nesting exceeds its envelope depth.");
        // Generated object/header, union storage and semantic node; repeated capacity is charged per entry.
        budget.Charge(128);
        while (input.Position < end)
        {
            var tag = input.ReadTag(); if (tag == 0) throw new InvalidDataException("Invalid Monty field tag.");
            var field = schema.FindFieldByNumber(WireFormat.GetTagFieldNumber(tag));
            var wire = WireFormat.GetTagWireType(tag);
            if (field is null || !Matches(field, wire)) { input.SkipLastField(); Bounds(input, end); continue; }
            if (field.IsRepeated) budget.Charge(32);
            if (wire == WireFormat.WireType.LengthDelimited)
            {
                if (field.FieldType == FieldType.Message)
                {
                    var length = input.ReadLength(); var childEnd = checked(input.Position + length);
                    if (childEnd > end) throw new InvalidDataException("Monty message extends beyond its envelope.");
                    Message(input, frame, childEnd, field.MessageType, budget, depth + 1);
                    if (input.Position != childEnd) throw new InvalidDataException("Monty message boundary mismatch.");
                }
                else if (field.FieldType is FieldType.String or FieldType.Bytes)
                {
                    // A bounded standard reader peeks only the length; SkipLastField avoids allocating payload.
                    budget.Charge(96);
                    using var lengthReader = new CodedInputStream(frame, (int)input.Position, (int)(end - input.Position));
                    var length = lengthReader.ReadLength();
                    if (lengthReader.Position + length > end) throw new InvalidDataException("Monty data extends beyond its envelope.");
                    budget.Charge(checked((field.FieldType == FieldType.String ? 8L : 4L) * length + 96));
                    input.SkipLastField();
                }
                else
                {
                    var length = input.ReadLength(); var packedEnd = checked(input.Position + length);
                    if (packedEnd > end) throw new InvalidDataException("Monty packed values extend beyond their envelope.");
                    while (input.Position < packedEnd) { budget.Charge(32); Scalar(input, field.FieldType); Bounds(input, packedEnd); }
                }
            }
            else Scalar(input, field.FieldType);
            Bounds(input, end);
        }
    }
    private static void Bounds(CodedInputStream input, long end)
    { if (input.Position > end) throw new InvalidDataException("Monty field extends beyond its envelope."); }
    private static bool Matches(FieldDescriptor field, WireFormat.WireType wire) => field.FieldType switch
    {
        FieldType.Message or FieldType.Bytes or FieldType.String => wire == WireFormat.WireType.LengthDelimited,
        FieldType.Double or FieldType.Fixed64 or FieldType.SFixed64 => wire == WireFormat.WireType.Fixed64 || field.IsRepeated && wire == WireFormat.WireType.LengthDelimited,
        FieldType.Float or FieldType.Fixed32 or FieldType.SFixed32 => wire == WireFormat.WireType.Fixed32 || field.IsRepeated && wire == WireFormat.WireType.LengthDelimited,
        _ => wire == WireFormat.WireType.Varint || field.IsRepeated && wire == WireFormat.WireType.LengthDelimited
    };
    private static void Scalar(CodedInputStream input, FieldType type)
    {
        switch (type)
        {
            case FieldType.Double: case FieldType.Fixed64: case FieldType.SFixed64: _ = input.ReadFixed64(); break;
            case FieldType.Float: case FieldType.Fixed32: case FieldType.SFixed32: _ = input.ReadFixed32(); break;
            default: _ = input.ReadUInt64(); break;
        }
    }
}
