---
name: apply-patch-guide
description: "How to use the apply_patch tool: patch format, syntax rules, and worked examples. Load this when you need to construct an apply_patch input and are unsure of the format."
---

# apply_patch Format Guide

## Basic Structure

```
*** Begin Patch
*** Update File: <path>
 ...patch lines...
*** End Patch
```

Each file operation starts with a header line. Multiple operations can be included in a single patch.

## Three File Operations

| Header | Action | Body |
|--------|--------|------|
| `*** Update File: <path>` | Modify an existing file | Diff lines (see below) |
| `*** Add File: <path>` | Create a new file | Every line starts with `+` |
| `*** Delete File: <path>` | Delete a file | No body |

## Update File Line Format

Each line must start with one of these prefixes:

| Prefix | Meaning |
|--------|---------|
| ` ` (space) | Context line — must **exactly match** existing file content |
| `-` | Delete this line — must match existing content |
| `+` | Insert this line (new content) |

### `@@` Section Marker

- `@@` on its own line starts a new section
- `@@ <anchor text>` — the anchor text helps locate the position in the file (the parser searches for the text first, then matches context nearby)
- **When context is not unique** (e.g. a bare ` ``` ` line appears multiple times in a Markdown file), add an anchor to disambiguate. Without an anchor, the parser may fail to match. A unique snippet from nearby lines works well as an anchor.
- The `@@` for the first section can be omitted

### `*** End of File`

- Placed after a block of context lines, means "these context lines should appear at the end of the file"
- Used for appending content to the end of a file

## Key Rules

1. **Context lines must exactly match existing file content** (including blank lines, indentation)
2. **Blank lines need a space prefix** — write a single space, don't leave the line empty
3. A single patch can contain multiple operations across multiple files
4. `*** Delete File` + `*** Add File` on the same path = rewrite the file

## Example File

Assume `/a.txt` contains:
```
aa
bb
cc
dd
cc
```
(Two `cc` lines on purpose — to demonstrate how context lines disambiguate.)

### Example 1: Change the first cc → XX

Use context lines `bb` (above) and `dd` (below) to target the first `cc`:

```
*** Begin Patch
*** Update File: /a.txt
@@
 bb
-cc
+XX
 dd
*** End Patch
```

**Result:**
```
aa
bb
XX
dd
cc
```
The second `cc` is unaffected.

### Example 2: Delete the second cc

Use `dd` as the preceding context to target the second `cc`:

```
*** Begin Patch
*** Update File: /a.txt
@@
 dd
-cc
*** End Patch
```

**Result:**
```
aa
bb
cc
dd
```

### Example 3: Insert at the top + append at the end (multiple sections)

Two `@@` sections, operating at different locations:

```
*** Begin Patch
*** Update File: /a.txt
@@
+new top line
 aa
@@
 dd
+ee
+ff
*** End of File
*** End Patch
```

**Result:**
```
new top line
aa
bb
cc
dd
ee
ff
```

### Example 4: Create a new file

Add File body — every line starts with `+`:

```
*** Begin Patch
*** Add File: /new.txt
+line 1
+line 2
+line 3
*** End Patch
```

**Result:** `/new.txt` is created with content `line 1\nline 2\nline 3`.

### Example 5: Delete a file

```
*** Begin Patch
*** Delete File: /old.txt
*** End Patch
```

**Result:** `/old.txt` is deleted.

### Example 6: Rewrite a file (Delete + Add same path)

Delete then Add the same file — equivalent to a full rewrite:

```
*** Begin Patch
*** Delete File: /a.txt
*** Add File: /a.txt
+completely
+new
+content
*** End Patch
```

**Result:** `/a.txt` content becomes:
```
completely
new
content
```

### Example 7: Multiple files in one patch

```
*** Begin Patch
*** Update File: src/a.ts
@@
-old line
+new line
*** Add File: src/b.ts
+export const b = 1;
*** Delete File: src/old.ts
*** End Patch
```

**Result:** `src/a.ts` has one line changed, `src/b.ts` is created, `src/old.ts` is deleted.

## Common Mistakes

- **Context line mismatch**: Check that context lines exactly match the file (including indentation, blank lines)
- **Forgot space prefix on blank lines**: A blank line in the patch must be written as a single space, not an empty line
- **Using context instead of deletion for lines to remove**: Lines you want to delete must use `-` prefix; lines you want to keep as context use space prefix
- **Replacing a line by keeping it as context + adding a new line**: To replace a line, you must use `-` (delete the old line) **and** `+` (insert the new line). If you instead keep the old line as context (space prefix) and only add a `+` line, both lines will exist in the result — the old line is not removed.
- **Forgot `+` in Add File body**: Every line in an Add File section must start with `+`
