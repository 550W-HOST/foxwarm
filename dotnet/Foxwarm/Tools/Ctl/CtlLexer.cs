using System.Text;

namespace Foxwarm.Tools;

internal sealed record CtlToken(string Text, bool Quoted, int Start);

// POSIX-style word splitting without any expansion. Tokens are read on demand so a trailing
// rest parameter can take the remaining raw text without tokenizing it.
internal sealed class CtlLexer(string text)
{
    private int position;

    internal const string NotAShell =
        "ctl is not a shell: pipes, redirection, command lists, substitution and backgrounding are not supported. Quote the character to pass it literally, or use run_script to combine calls.";

    internal bool AtEnd
    {
        get
        {
            SkipSpace();
            return position >= text.Length;
        }
    }

    // The raw text from the next token to the end, without its leading whitespace.
    internal string Remainder()
    {
        SkipSpace();
        var rest = text[position..];
        position = text.Length;
        return rest;
    }

    internal bool PeekStartsWith(string prefix)
    {
        SkipSpace();
        return string.CompareOrdinal(text, position, prefix, 0, prefix.Length) == 0;
    }

    private void SkipSpace()
    {
        while (position < text.Length && char.IsWhiteSpace(text[position]))
            position++;
    }

    internal CtlToken? Next()
    {
        SkipSpace();
        if (position >= text.Length)
            return null;
        var start = position;
        var builder = new StringBuilder();
        var quoted = false;
        while (position < text.Length && !char.IsWhiteSpace(text[position]))
        {
            var current = text[position];
            if (current == '\'')
            {
                quoted = true;
                var end = text.IndexOf('\'', position + 1);
                if (end < 0)
                    throw new InvalidDataException("Unterminated single quote.");
                builder.Append(text, position + 1, end - position - 1);
                position = end + 1;
            }
            else if (current == '"')
            {
                quoted = true;
                position++;
                var closed = false;
                while (position < text.Length)
                {
                    var inner = text[position];
                    if (inner == '"')
                    {
                        closed = true;
                        position++;
                        break;
                    }
                    if (
                        inner == '\\'
                        && position + 1 < text.Length
                        && text[position + 1] is '"' or '\\'
                    )
                    {
                        builder.Append(text[position + 1]);
                        position += 2;
                        continue;
                    }
                    builder.Append(inner);
                    position++;
                }
                if (!closed)
                    throw new InvalidDataException("Unterminated double quote.");
            }
            else if (current == '\\')
            {
                if (position + 1 >= text.Length)
                    throw new InvalidDataException("A trailing backslash escapes nothing.");
                quoted = true;
                builder.Append(text[position + 1]);
                position += 2;
            }
            else if (
                current is '|' or ';' or '&' or '<' or '>' or '`'
                || current == '$' && position + 1 < text.Length && text[position + 1] == '('
            )
                throw new InvalidDataException(
                    $"Unquoted `{(current == '$' ? "$(" : current.ToString())}`: " + NotAShell
                );
            else
            {
                builder.Append(current);
                position++;
            }
        }
        return new(builder.ToString(), quoted, start);
    }
}
