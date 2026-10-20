using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ArtifactToolDefinition
{
    internal static JsonObject Definition() =>
        JsonNode
            .Parse(
                """
{
  "name": "artifact",
  "description": "Prepare or publish an immutable image, chart or sandboxed React artifact in the current Session. prepare returns a marker for insertion between prose paragraphs without showing a separate card; publish shows a standalone reply card; send_file remains a separate file-delivery action. Load data-visualization or react-artifacts skill for manifest formats. The manifest JSON contains all data/source files; no external URLs or arbitrary dependencies. Revisions leave prior replies unchanged.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "prepare",
          "publish",
          "get"
        ]
      },
      "filePath": {
        "type": "string",
        "description": "Self-contained JSON manifest (2 MiB), or raster image when type=image (12 MiB), on the source Node."
      },
      "type": {
        "type": "string",
        "enum": [
          "image"
        ],
        "description": "Use for PNG/JPEG/GIF/WebP image files. Omit for JSON chart/React manifests."
      },
      "title": {
        "type": "string",
        "maxLength": 160,
        "description": "Optional image title; otherwise its filename."
      },
      "alt": {
        "type": "string",
        "maxLength": 1000,
        "description": "Optional accessible image description."
      },
      "node": {
        "type": "string",
        "description": "Source Node; defaults to the current Session Node."
      },
      "artifactId": {
        "type": "string",
        "description": "Existing artifact ID when publishing a new revision."
      },
      "revision": {
        "type": "integer",
        "minimum": 1,
        "description": "For get: optional specific revision; omit for latest publication metadata."
      },
      "expectedRevision": {
        "type": "integer",
        "minimum": 1,
        "description": "Required previous revision for an update; conflicts are rejected."
      }
    },
    "required": [
      "action"
    ]
  }
}
"""
            )!
            .AsObject();
}
