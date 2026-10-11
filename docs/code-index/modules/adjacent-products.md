# Module: VS Code Web and website

Adjacent product assets consumed or deployed separately from the .NET host.

## Units

- [Static website, focused documentation, and installer/download pages](../units/website-site.md)
- [VS Code Web packaging and browser extensions](../units/vscode-web-extensions.md)

## Boundaries

The .NET project embeds selected Code extension assets and registers host capability routes through `CodeWorkbench`. See the [.NET WebUI boundary](../threads/dotnet-webui-boundary.md). Website and compatibility-platform documentation do not establish that the root launcher or remote Node integration has switched to .NET.
