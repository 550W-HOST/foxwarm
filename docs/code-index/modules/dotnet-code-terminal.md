# Module: Code and terminal

Code workbench/file/Git routes, Code helper IPC, and PTY lifecycle.

## Boundaries

This module documents current .NET source behavior. Cross-module contracts belong to the linked threads; do not infer migration completion from the presence of a C# implementation.

## Units

- [Code workbench and Git/file services](../units/code-services.md)
- [External Node Code service transport](../units/external-node-services.md)
- [Terminal and Code helper services](../units/terminal.md)

## Tests and callers

Use the unit pages for stable symbols and representative tests. Search `dotnet/Foxwarm.Tests/` by the feature directory when a broader regression surface is needed.
