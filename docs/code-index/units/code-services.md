# Unit: Code workbench and Git/file services

Files: `dotnet/Foxwarm/Code/CodeFileService.cs`, `dotnet/Foxwarm/Code/CodeGitService.Commit.cs`, `dotnet/Foxwarm/Code/CodeGitService.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.Routes.cs`, `dotnet/Foxwarm/Code/CodeWorkbench.cs`

## Purpose

Serves source files and Git metadata through the Code workbench boundary, including optional VS Code Web capability requests.

## Stable symbols and callers

`CodeWorkbench.Register`; `CodeFileService`; `CodeGitService`.

Callers and adjacent boundaries: HttpServer; WebUI workbench components; TerminalRegistry.

## Tests

dotnet/Foxwarm.Tests/Channels/CodeRoutesTests.cs
