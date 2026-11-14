---
name: data-visualization
description: Create interactive WebUI charts and metric dashboards from data, including training curves, rolling averages, comparisons, scatter plots and heatmaps. Create versioned charts or image figures, embedded between prose paragraphs or displayed as standalone cards.
---
# Data visualization

Use `artifact` for a chart or image figure. Choose `prepare` for a figure between prose paragraphs, or `publish` for a separate reply-end card. Both render outside Activity. Other clients receive the publication summary; offer a static figure or data file when they need one.

1. Read the source data. Preserve units, missing values and provenance; do not fabricate measured values.
2. Write one UTF-8 JSON manifest on the source Node, using the format below. All data is embedded in this snapshot. Aggregate oversized input before publishing and retain the original data separately.
3. Discover `artifact` with `search_tools`, then call `artifact({action:"prepare",filePath:"chart.json"})`. Place its exact returned `marker` between the relevant paragraphs, on its own line at column 0 with blank lines above and below. Add a short ordinary Markdown caption beneath it. For a standalone reply-end card, use `action:"publish"` instead. `node` explicitly selects a source Node when needed.
4. Explain the result briefly. Do not paste the entire manifest into the reply.
5. To update, provide the returned `artifactId` and `expectedRevision`. A new revision is published; old replies do not change. A conflict requires reading the latest publication, not blindly retrying.

## Existing image figures

Use `{action:"prepare",type:"image",filePath:"figure.png",title:"Figure title",alt:"Brief accessible description"}` to snapshot a PNG/JPEG/GIF/WebP file. Images use the same returned body marker and open the shared full-screen image viewer when clicked. Files are bounded to 12 MiB and 40 megapixels; animated images have additional frame/decoded-size bounds. Export SVG/PDF figures to PNG first. No external image URLs or live source paths are embedded.

Use `send_file` when the goal is to deliver a file attachment rather than place a figure in the prose. A body reference and file delivery are independent choices; do not perform both unless useful. Reuse the marker from `get` for an existing snapshot owned by this Session instead of uploading it again.

Markers outside ordinary assistant prose, inside code/quotes/lists, or in other Sessions do not grant access or start a preview. Partial streamed markers do not mount a renderer. `prepare` alone displays no card.

## Manifest v1

- `type: "chart"`, `schemaVersion: 1`, `title`; optional short `description`, `source`.
- `data`: 1–20,000 rows; at most 32 fields. Field names are alphanumeric/underscore and start with a letter. Values: finite number, string up to 500 characters, boolean or null. Entire manifest at most 2 MiB.
- `spec`: a closed Vega-Lite subset. Use `mark` + `encoding`, or up to eight `layer` objects. Marks: line, area, bar, point, circle, rect, rule, tick. Mark objects accept type, hexadecimal color, opacity, strokeWidth, point, interpolate. Encodings: x, y, x2, y2, color, size, shape, opacity, tooltip (also an array), detail, order. Field types: quantitative, temporal, ordinal, nominal. Basic title, scalar value, aggregate (mean/sum/min/max/count/median), boolean bin, ascending/descending sort, scale, axis and legend options are supported. Width is responsive (`"container"`); optional height is 160–640.
- Layers may have a unique `name` and short `title` for a visibility checkbox.
- `controls.recent`: optional number of latest rows, preserving supplied order.
- `controls.smoothing`: `{field,as,window}`; trailing mean over 1–200 rows, ignoring nulls. `as` is a new field usable in the spec. The user can adjust its window. Smoothing is computed before the recent-row display filter.
- `metrics`: up to six `{label,field,aggregate:"last"|"mean",window?,percent?}`. Metrics use the complete snapshot or their explicit trailing window, not the display filter. Percent assumes values in [0,1].

No external URLs, arbitrary expressions, authored transforms/signals or custom JavaScript. Use the `react-artifacts` skill for custom layouts or algorithms. Use conventional units/axis labels, do not smooth without labeling it, and avoid line interpolation that invents extrema.

## Example

[Training metrics](examples/training-metrics.json) is synthetic demonstration data, not experiment evidence. Copy its structure, replace data/title/source with the actual dataset, and publish. Validation errors are returned before publication. Unknown fields are rejected rather than silently ignored.

Use `artifact({action:"get",artifactId})` to inspect the latest revision metadata, or add `revision` for a historical one. This does not republish or change the content.
