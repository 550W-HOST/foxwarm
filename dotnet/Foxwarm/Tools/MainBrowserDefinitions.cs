using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class MainBrowserDefinitions
{
    internal static bool Contains(string name) =>
        name
            is "browse_open"
                or "browse_list"
                or "browse_get"
                or "browse_close"
                or "browse_interact";

    internal static JsonArray All() =>
        JsonNode
            .Parse(
                """
[
  {
    "name": "browse_open",
    "description": "Open a browser tab at a URL and return its tab ID for later browser calls.",
    "parameters": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "URL to open."
        }
      },
      "required": [
        "url"
      ]
    }
  },
  {
    "name": "browse_list",
    "description": "List open browser tabs with their IDs, titles, and URLs.",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "browse_get",
    "description": "Read a browser tab's text or capture its screenshot.",
    "parameters": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "string",
          "description": "Tab ID returned by browse_open or browse_list."
        },
        "screenshot": {
          "type": [
            "boolean",
            "string"
          ],
          "description": "Omit or set false for text. Set true to return an image, or provide an absolute path beginning with / to save the screenshot there.",
          "default": false
        }
      },
      "required": [
        "tabId"
      ]
    }
  },
  {
    "name": "browse_close",
    "description": "Close a browser tab.",
    "parameters": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "string",
          "description": "Tab to close."
        }
      },
      "required": [
        "tabId"
      ]
    }
  },
  {
    "name": "browse_interact",
    "description": "Interact with a browser tab: click, type, fill, press a key, scroll, wait, evaluate JavaScript, or navigate.",
    "parameters": {
      "type": "object",
      "properties": {
        "tabId": {
          "type": "string",
          "description": "Tab to control."
        },
        "action": {
          "type": "string",
          "description": "Browser action to perform.",
          "enum": [
            "click",
            "type",
            "fill",
            "press",
            "scroll",
            "wait",
            "evaluate",
            "goto",
            "back",
            "forward",
            "reload"
          ]
        },
        "params": {
          "type": "object",
          "description": "Arguments for the action, such as {selector: '#id'} for click, {selector: 'input', text: 'hello'} for fill, {key: 'Enter'} for press, {y: 500} for scroll, {url: 'https://example.com'} for goto, or {code: 'document.title'} for evaluate.",
          "properties": {
            "selector": {
              "type": "string",
              "description": "CSS selector for the target element."
            },
            "text": {
              "type": "string",
              "description": "Text to type or fill."
            },
            "key": {
              "type": "string",
              "description": "Key to press, such as Enter, Tab, or Escape."
            },
            "y": {
              "type": "number",
              "description": "Vertical scroll distance in pixels."
            },
            "url": {
              "type": "string",
              "description": "Destination URL for goto."
            },
            "code": {
              "type": "string",
              "description": "JavaScript to evaluate in the tab."
            },
            "timeout": {
              "type": "number",
              "description": "Action timeout in milliseconds. Defaults to 5,000."
            }
          }
        }
      },
      "required": [
        "tabId",
        "action"
      ]
    }
  }
]
"""
            )!
            .AsArray();
}
