namespace Foxwarm.Vector;

// Script=Han ranges from the Source runtime Unicode 16.0 property table.
internal static class SourceHanRanges
{
    internal static bool Contains(int value) =>
        Ranges.Any(range => value >= range.Start && value <= range.End);

    private static readonly (int Start, int End)[] Ranges =
    [
        (0x2e80, 0x2e99),
        (0x2e9b, 0x2ef3),
        (0x2f00, 0x2fd5),
        (0x3005, 0x3005),
        (0x3007, 0x3007),
        (0x3021, 0x3029),
        (0x3038, 0x303b),
        (0x3400, 0x4dbf),
        (0x4e00, 0x9fff),
        (0xf900, 0xfa6d),
        (0xfa70, 0xfad9),
        (0x16fe2, 0x16fe3),
        (0x16ff0, 0x16ff1),
        (0x20000, 0x2a6df),
        (0x2a700, 0x2b739),
        (0x2b740, 0x2b81d),
        (0x2b820, 0x2cea1),
        (0x2ceb0, 0x2ebe0),
        (0x2ebf0, 0x2ee5d),
        (0x2f800, 0x2fa1d),
        (0x30000, 0x3134a),
        (0x31350, 0x323af),
    ];
}
