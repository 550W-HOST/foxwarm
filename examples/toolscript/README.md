# ToolScript examples

Canonical examples live here so agents can inspect a small, stable starting point instead of grepping tests.

These examples assume you have already explored the relevant tools in the normal agent loop and now want to encode a known tool flow into a reusable script.

Files:

- `examples/toolscript/automation_basic.py`
- `examples/toolscript/managed_controller_basic.py`

These examples intentionally stay small and avoid product-specific business logic.
They focus on the common case where you already know the tool flow you want to encode into a reusable script.

Each example uses the current explicit ToolScript entrypoint shape:

```python
def main(args):
    ...
    return {...}
```