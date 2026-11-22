# Unit: Artifact preparation runtime

Files: `packages/artifact-runtime/src/managedPrepare.ts`, `packages/artifact-runtime/src/reactCompiler.ts`, `packages/artifact-runtime/src/rasterMetadata.ts`, `packages/artifact-runtime/test/runtimeHelpers.test.mjs`, `packages/artifact-runtime/tsconfig.json`, `packages/artifact-runtime/package.json`

Secondary files: `dotnet/Foxwarm/Artifacts/ArtifactPreparer.cs`, `dotnet/Foxwarm/Delivery.targets`, `scripts/collect-artifact-runtime.mjs`, `Dockerfile`, `dotnet/scripts/validate-desktop-package.mjs`, `dotnet/scripts/qualify-desktop-mac-package.mjs`

## Purpose

The data-only Node child that [managed artifact publication](./dotnet-artifacts.md) starts for each preparation request. It keeps the Main-only esbuild/sharp operations out of the [Shared package](./shared-artifacts.md), whose dependency closure also serves Node clients. Canonical decisions: [interactive artifacts](../threads/webui-artifacts.md).

## Symbols

- `managedPrepare`: one bounded stdin/stdout JSON request per child (`validate`, `react` or `image`), at most 18 MiB of input, a JSON `error` with exit code 1 on failure. It has no Session, source-file, tool or HTTP authority.
- `compileReact`: validates the React document with the Shared validator and bundles it with esbuild from virtual authored files. Only `react`, `react/jsx-runtime`, `react/jsx-dev-runtime` and `react-dom/client` resolve, from the fixed WebUI React runtime; any other bare, Node or network import is rejected. The output is never evaluated, and output over 3 MiB fails.
- `describeImage`: accepts PNG, JPEG, GIF and WebP by magic bytes, then bounds dimensions and animation frames through sharp metadata before returning a Shared-validated image document. There is no SVG/HTML fallback.

## Layout and delivery

`npm run build:artifacts` compiles `src/` to `packages/artifact-runtime/dist/` with the root `typescript`, after `build:node` has built the Shared validators it imports from `packages/shared/dist`. Relative paths are fixed by the package layout: Shared is `../../shared/dist` and the React runtime is `../../webui/node_modules` from `dist/`. esbuild and sharp resolve through the ordinary parent `node_modules` lookup, which is the repository root in a checkout and the payload root in a delivery.

`Delivery.targets` carries exactly the three compiled `.js` files at `packages/artifact-runtime/dist/` beside Shared, and the [artifact runtime collector](./dotnet-artifacts.md#delivery) adds target-native esbuild/sharp and the WebUI React closure at the payload root. `ArtifactPreparer` defaults to `<install>/packages/artifact-runtime/dist/managedPrepare.js`. The install path is internal; the C# host and this runtime always ship together. The Docker build copies this package and builds it through `build:assets`; both Desktop package checks require the entry file.

## Verification

`runtimeHelpers.test.mjs` (the routine `runtime-helpers` group) checks bundled skill manifests against the Shared validators, compiler import restrictions without execution and raster metadata, against the compiled `dist/`. `ArtifactStoreTests` and `WebUiStartupTests` drive the same entry through `ArtifactPreparer` from the test output; `test:published` proves the collected React compiler and an original-App artifact run from a complete publication.
