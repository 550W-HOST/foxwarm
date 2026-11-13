using System.Text.Json;

namespace Foxwarm;

/// <summary>A rectangle in the page's CSS pixels, or in device pixels after scaling.</summary>
internal readonly record struct FrameRect(double X, double Y, double Width, double Height)
{
    internal double Right => X + Width;
    internal double Bottom => Y + Height;
}

/// <summary>
/// The one page-to-host message of the Desktop hosts' custom window frame: drag rectangles
/// for the window's title area and the page's color scheme. Both hosts accept it only from
/// their own top-level document and ignore anything that doesn't match this exact shape.
/// </summary>
internal sealed record DesktopFrameRegions(IReadOnlyList<FrameRect> Regions, bool Dark)
{
    internal const int RegionLimit = 128;
    private const double CoordinateLimit = 100_000;

    /// <summary>
    /// Parses <c>{ "type": "frame-regions", "regions": [[x, y, w, h], …], "colorScheme": "light" | "dark" }</c>
    /// with no other members; returns null for anything else.
    /// </summary>
    internal static DesktopFrameRegions? Parse(string? json)
    {
        if (string.IsNullOrEmpty(json) || json.Length > 64 * 1024)
            return null;
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return null;
            string? type = null;
            string? scheme = null;
            List<FrameRect>? regions = null;
            var members = 0;
            foreach (var member in root.EnumerateObject())
            {
                members++;
                switch (member.Name)
                {
                    case "type" when member.Value.ValueKind == JsonValueKind.String:
                        type = member.Value.GetString();
                        break;
                    case "colorScheme" when member.Value.ValueKind == JsonValueKind.String:
                        scheme = member.Value.GetString();
                        break;
                    case "regions" when member.Value.ValueKind == JsonValueKind.Array:
                        regions = ParseRegions(member.Value);
                        if (regions is null)
                            return null;
                        break;
                    default:
                        return null;
                }
            }
            if (members != 3 || type != "frame-regions" || regions is null || scheme is not ("light" or "dark"))
                return null;
            return new DesktopFrameRegions(regions, scheme == "dark");
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static List<FrameRect>? ParseRegions(JsonElement array)
    {
        if (array.GetArrayLength() > RegionLimit)
            return null;
        var regions = new List<FrameRect>(array.GetArrayLength());
        Span<double> values = stackalloc double[4];
        foreach (var item in array.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Array || item.GetArrayLength() != 4)
                return null;
            var index = 0;
            foreach (var number in item.EnumerateArray())
            {
                if (
                    number.ValueKind != JsonValueKind.Number
                    || !number.TryGetDouble(out var value)
                    || !double.IsFinite(value)
                    || Math.Abs(value) > CoordinateLimit
                )
                    return null;
                values[index++] = value;
            }
            if (values[2] < 0 || values[3] < 0)
                return null;
            regions.Add(new FrameRect(values[0], values[1], values[2], values[3]));
        }
        return regions;
    }

    /// <summary>
    /// Scales the regions, clips them to the window's bounds and removes the window-control
    /// zones, which the page's drag surfaces may extend under.
    /// </summary>
    internal IReadOnlyList<FrameRect> Clip(
        double scale,
        FrameRect bounds,
        IEnumerable<FrameRect> excluded
    )
    {
        var holes = excluded.Where(zone => zone.Width > 0 && zone.Height > 0).ToArray();
        var result = new List<FrameRect>();
        foreach (var region in Regions)
        {
            var scaled = new FrameRect(
                region.X * scale,
                region.Y * scale,
                region.Width * scale,
                region.Height * scale
            );
            var clipped = Intersect(scaled, bounds);
            if (clipped is null)
                continue;
            var parts = new List<FrameRect> { clipped.Value };
            foreach (var hole in holes)
                parts = parts.SelectMany(part => Subtract(part, hole)).ToList();
            result.AddRange(parts.Where(part => part.Width >= 1 && part.Height >= 1));
        }
        return result;
    }

    internal static FrameRect? Intersect(FrameRect a, FrameRect b)
    {
        var x1 = Math.Max(a.X, b.X);
        var y1 = Math.Max(a.Y, b.Y);
        var x2 = Math.Min(a.Right, b.Right);
        var y2 = Math.Min(a.Bottom, b.Bottom);
        return x1 < x2 && y1 < y2 ? new FrameRect(x1, y1, x2 - x1, y2 - y1) : null;
    }

    internal static IEnumerable<FrameRect> Subtract(FrameRect base_, FrameRect hole)
    {
        var overlap = Intersect(base_, hole);
        if (overlap is not { } o)
        {
            yield return base_;
            yield break;
        }
        if (o.Y > base_.Y)
            yield return new FrameRect(base_.X, base_.Y, base_.Width, o.Y - base_.Y);
        if (o.Bottom < base_.Bottom)
            yield return new FrameRect(base_.X, o.Bottom, base_.Width, base_.Bottom - o.Bottom);
        if (o.X > base_.X)
            yield return new FrameRect(base_.X, o.Y, o.X - base_.X, o.Height);
        if (o.Right < base_.Right)
            yield return new FrameRect(o.Right, o.Y, base_.Right - o.Right, o.Height);
    }
}
