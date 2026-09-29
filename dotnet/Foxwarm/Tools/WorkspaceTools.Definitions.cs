using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

public sealed partial class WorkspaceTools
{
    private static JsonObject EditDefinition() => new()
    {
        ["type"] = "function", ["name"] = "edit",
        ["description"] = "Replace one exact occurrence of text in a UTF-8 file in the configured tool workspace. Use apply_patch for line-based changes. Files and resulting content are limited to 1 MiB; symbolic links are not supported.",
        ["parameters"] = new JsonObject
        {
            ["type"] = "object", ["additionalProperties"] = false,
            ["properties"] = new JsonObject
            {
                ["filePath"] = new JsonObject { ["type"] = "string", ["description"] = "Path to an existing file, relative to the tool workspace." },
                ["oldText"] = new JsonObject { ["type"] = "string", ["description"] = "Exact text to replace; it must identify a single occurrence." },
                ["newText"] = new JsonObject { ["type"] = "string", ["description"] = "Replacement text." }
            },
            ["required"] = new JsonArray("filePath", "oldText", "newText")
        },
        ["strict"] = false
    };

    private static JsonObject PatchDefinition() => new()
    {
        ["type"] = "function", ["name"] = "apply_patch",
        ["description"] = "Add, modify, or delete UTF-8 files with a line-based patch. Paths in patch headers are relative to the configured tool workspace. Files and resulting content are limited to 1 MiB; symbolic links are not supported. Missing parent directories are created for added files. Operations are applied in order; if one fails, earlier changes may remain. Supply the patch as input.\n\n" + """"
The patch must be enclosed in `*** Begin Patch` / `*** End Patch`. Each file operation starts with a header line:
- `*** Update File: <path>` — modify an existing file
- `*** Add File: <path>` — create a new file (all body lines must start with `+`)
- `*** Delete File: <path>` — delete a file (no body lines)

For Update File, the body uses line-based diff syntax:
- Lines starting with a single space ` ` are context (must match the existing file content)
- Lines starting with `-` are deletions (must match existing content)
- Lines starting with `+` are insertions (new content)
- `@@` or `@@ <anchor text>` starts a new section (anchor text helps locate the position in the file)
- `*** End of File` marks that the following context is at the end of the file

Example:
```
*** Begin Patch
*** Update File: src/app.ts
@@ function main()
 import { foo } from './foo';
-const old = 'removed';
+const newVar = 'added';
 console.log(newVar);
*** Add File: src/newfile.ts
+export const hello = 'world';
*** End Patch
```
"""",
        ["parameters"] = new JsonObject
        {
            ["type"] = "object", ["additionalProperties"] = false,
            ["properties"] = new JsonObject
            {
                ["input"] = new JsonObject { ["type"] = "string", ["description"] = "Complete patch text in the format described above." }
            },
            ["required"] = new JsonArray("input")
        },
        ["strict"] = false
    };
}
