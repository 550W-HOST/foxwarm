using System.Buffers;

namespace Foxwarm.Models;

internal sealed partial class TextRedactor
{
    private readonly object snapshotGate = new();
    private KnownOriginals? snapshot;

    // Changes whenever a retained original is added or evicted (under `gate`).
    private long knownGeneration;

    // An immutable matcher over the originals retained when it was built. It is rebuilt only
    // when a scan is needed after registrations changed, outside the global lock, so masking
    // never holds that lock for a slot.
    internal KnownOriginals KnownSnapshot()
    {
        long generation;
        lock (gate)
            generation = knownGeneration;
        var current = Volatile.Read(ref snapshot);
        if (current?.Generation == generation)
            return current;
        lock (snapshotGate)
        {
            Known[] entries;
            lock (gate)
            {
                generation = knownGeneration;
                current = snapshot;
                if (current?.Generation == generation)
                    return current;
                entries = knownOrder.Where(entry => entry.Original.Length >= 2).ToArray();
            }
            current = new KnownOriginals(entries, generation);
            Volatile.Write(ref snapshot, current);
            return current;
        }
    }

    // Exact occurrences of retained originals, leftmost and then longest first. Existing
    // placeholders and secret markers are never entered. An original whose edge is an ASCII
    // letter or digit only matches where the neighbouring character is not one, so a short
    // name does not replace part of a longer word. Originals detected only under labels this
    // request excludes, and originals on its keep list, stay unchanged. The scan is one Aho-Corasick pass, linear in the text
    // length plus the occurrences found.
    internal List<Found> FindKnown(
        KnownOriginals originals,
        string text,
        TextRedactionOptions options
    )
    {
        var found = new List<Found>();
        if (text.Length < 2 || originals.IsEmpty)
            return found;
        var cursor = 0;
        foreach (var (start, end) in Guarded(text))
        {
            if (start > cursor)
                originals.Scan(text, cursor, start, options, found);
            cursor = Math.Max(cursor, end);
        }
        if (cursor < text.Length)
            originals.Scan(text, cursor, text.Length, options, found);
        return found;
    }

    internal sealed class KnownOriginals
    {
        private const int Root = 0;
        private readonly Dictionary<long, int> next = new();
        private readonly int[] fail;
        private readonly int[] depth;

        // The original ending at a state, and the nearest suffix state that ends one.
        private readonly int[] output;
        private readonly int[] outputLink;
        private readonly Known[] patterns;

        internal long Generation { get; }
        internal bool IsEmpty => patterns.Length == 0;

        internal KnownOriginals(Known[] entries, long generation)
        {
            Generation = generation;
            patterns = entries;
            var depths = new List<int> { 0 };
            var outputs = new List<int> { -1 };
            var edges = new List<(int Parent, char Character, int Child)>();
            for (var index = 0; index < entries.Length; index++)
            {
                var state = Root;
                foreach (var character in entries[index].Original)
                {
                    if (!next.TryGetValue(Edge(state, character), out var child))
                    {
                        child = depths.Count;
                        depths.Add(depths[state] + 1);
                        outputs.Add(-1);
                        next[Edge(state, character)] = child;
                        edges.Add((state, character, child));
                    }
                    state = child;
                }
                outputs[state] = index;
            }
            depth = [.. depths];
            output = [.. outputs];
            fail = new int[depth.Length];
            outputLink = new int[depth.Length];
            outputLink[Root] = -1;
            // Parents before children: edges ordered by the child's depth.
            edges.Sort((left, right) => depth[left.Child].CompareTo(depth[right.Child]));
            foreach (var (parent, character, child) in edges)
            {
                var link = Root;
                if (parent != Root)
                {
                    var candidate = fail[parent];
                    while (true)
                    {
                        if (next.TryGetValue(Edge(candidate, character), out var target))
                        {
                            link = target;
                            break;
                        }
                        if (candidate == Root)
                            break;
                        candidate = fail[candidate];
                    }
                }
                fail[child] = link;
                outputLink[child] = output[link] >= 0 ? link : outputLink[link];
            }
        }

        private static long Edge(int state, char character) => (long)state << 16 | character;

        // Matches inside [from, to); edge checks look at the whole text.
        internal void Scan(
            string text,
            int from,
            int to,
            TextRedactionOptions options,
            List<Found> found
        )
        {
            var length = to - from;
            if (length < 2)
                return;
            // Longest valid original starting at each offset of the range.
            var longest = ArrayPool<int>.Shared.Rent(length);
            try
            {
                Array.Clear(longest, 0, length);
                var state = Root;
                for (var end = from; end < to; end++)
                {
                    var character = text[end];
                    while (true)
                    {
                        if (next.TryGetValue(Edge(state, character), out var target))
                        {
                            state = target;
                            break;
                        }
                        if (state == Root)
                            break;
                        state = fail[state];
                    }
                    for (
                        var match = output[state] >= 0 ? state : outputLink[state];
                        match >= 0;
                        match = outputLink[match]
                    )
                    {
                        var size = depth[match];
                        var start = end - size + 1;
                        if (
                            size > longest[start - from]
                            && Bounded(text, start, size)
                            && !Excluded(patterns[output[match]].Labels, options.ExcludeLabels)
                            && !options.Keeps(patterns[output[match]].Original)
                        )
                            longest[start - from] = size;
                    }
                }
                for (var offset = 0; offset < length; )
                {
                    var size = longest[offset];
                    if (size == 0)
                    {
                        offset++;
                        continue;
                    }
                    var pattern = FindPattern(text, from + offset, size);
                    found.Add(
                        new(
                            from + offset,
                            size,
                            pattern.Placeholder,
                            pattern.Original,
                            pattern.Labels
                        )
                    );
                    offset += size;
                }
            }
            finally
            {
                ArrayPool<int>.Shared.Return(longest);
            }
        }

        // Originals are distinct, so the trie path of the matched text ends at its pattern.
        private Known FindPattern(string text, int start, int size)
        {
            var state = Root;
            for (var index = start; index < start + size; index++)
                state = next[Edge(state, text[index])];
            return patterns[output[state]];
        }
    }
}
