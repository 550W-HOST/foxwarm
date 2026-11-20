using System.Text;

namespace Foxwarm.Tools;

// Quoted is true when any part of the token was quoted or escaped. Plain is the length of the
// leading text written without quoting, which decides whether a token is an option.
internal sealed record CtlToken(string Text, bool Quoted, int Start, int Plain)
{
    // An option: `--name` or `--name=value` whose `--name=` prefix is not quoted.
    internal bool IsOption(out string flag, out string? inline)
    {
        flag = "";
        inline = null;
        if (!Text.StartsWith("--", StringComparison.Ordinal) || Text.Length == 2)
            return false;
        var equals = Text.IndexOf('=', 2);
        var name = equals < 0 ? Text.Length : equals + 1;
        if (Plain < name)
            return false;
        flag = equals < 0 ? Text[2..] : Text[2..equals];
        inline = equals < 0 ? null : Text[(equals + 1)..];
        return true;
    }
}

// POSIX-style word splitting without any expansion. Shell operators are rejected for callers
// that might expect a shell (shell: true); user commands treat them as ordinary characters. Tokens are read on demand so a trailing
// rest parameter can take the remaining raw text without tokenizing it.
internal sealed class CtlLexer(string text, bool shell = true)
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
        while (position < text.Length && Space(text[position]))
            position++;
    }

    // User commands split words like their head (MessageRouter.CommandSpace, JavaScript \s).
    private bool Space(char value) =>
        shell
            ? char.IsWhiteSpace(value)
            : value is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00A0' or '\u1680' or '\u2028' or '\u2029' or '\u202F' or '\u205F' or '\u3000' or '\uFEFF'
                || value is >= '\u2000' and <= '\u200A';

    internal CtlToken? Next()
    {
        SkipSpace();
        if (position >= text.Length)
            return null;
        var start = position;
        var builder = new StringBuilder();
        var quoted = false;
        var plain = -1;
        while (position < text.Length && !Space(text[position]))
        {
            var current = text[position];
            if (current is '\'' or '"' or '\\' && plain < 0)
                plain = builder.Length;
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
                shell
                && (
                    current is '|' or ';' or '&' or '<' or '>' or '`'
                    || current == '$' && position + 1 < text.Length && text[position + 1] == '('
                )
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
        return new(builder.ToString(), quoted, start, plain < 0 ? builder.Length : plain);
    }
}
