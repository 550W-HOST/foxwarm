#!/usr/bin/env python3
"""
Android Node Server for Foxwarm
Provides Android automation tools via uiautomator2
"""

import asyncio
import base64
import json
import logging
import os
import shlex
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from typing import Dict, Any, Optional
from PIL import Image
import uiautomator2 as u2
from aiohttp import web
import websockets
from node_auth import (
    build_node_ws_url,
    clear_stored_credentials,
    load_stored_credentials,
    parse_connection_config,
    save_stored_credentials,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ANDROID_NODE_PING_INTERVAL = 30
ANDROID_NODE_PING_TIMEOUT = 10


# Tool definitions for dynamic registration
TOOL_DEFINITIONS = [
    {
        "name": "android_tap",
        "description": "Tap on Android screen at coordinates or on UI element",
        "parameters": {
            "type": "object",
            "properties": {
                "x": {"type": "number", "description": "X coordinate"},
                "y": {"type": "number", "description": "Y coordinate"},
                "text": {"type": "string", "description": "UI element text to tap"},
                "resourceId": {"type": "string", "description": "UI element resource ID"}
            }
        }
    },
    {
        "name": "android_swipe",
        "description": "Perform swipe gesture on Android screen",
        "parameters": {
            "type": "object",
            "properties": {
                "fx": {"type": "number", "description": "From X coordinate (alias: x1)"},
                "fy": {"type": "number", "description": "From Y coordinate (alias: y1)"},
                "tx": {"type": "number", "description": "To X coordinate (alias: x2)"},
                "ty": {"type": "number", "description": "To Y coordinate (alias: y2)"},
                "x1": {"type": "number", "description": "Alias for fx (from X coordinate)"},
                "y1": {"type": "number", "description": "Alias for fy (from Y coordinate)"},
                "x2": {"type": "number", "description": "Alias for tx (to X coordinate)"},
                "y2": {"type": "number", "description": "Alias for ty (to Y coordinate)"},
                "duration": {"type": "number", "description": "Duration in seconds", "default": 0.5}
            }
        }
    },
    {
        "name": "android_input",
        "description": "Input text on Android device",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text to input"}
            },
            "required": ["text"]
        }
    },
    {
        "name": "android_screenshot",
        "description": "Capture Android screen screenshot",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Output file path", "default": "/tmp/screenshot.png"},
                "inline": {"type": "boolean", "description": "If true, return the screenshot inline as JPEG image data (quality 80) instead of only returning a remote file path"}
            }
        }
    },
    {
        "name": "android_get_ui_tree",
        "description": "Get Android UI hierarchy XML",
        "parameters": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "android_list_elements",
        "description": "List simplified visible UI elements from the current Android screen",
        "parameters": {
            "type": "object",
            "properties": {
                "clickableOnly": {"type": "boolean", "description": "If true, only return clickable elements"},
                "limit": {"type": "number", "description": "Maximum number of elements to return", "default": 200}
            }
        }
    },
    {
        "name": "android_unlock",
        "description": "Wake Android device and unlock it with a numeric PIN",
        "parameters": {
            "type": "object",
            "properties": {
                "pin": {"type": "string", "description": "Numeric lockscreen PIN"}
            },
            "required": ["pin"]
        }
    },
    {
        "name": "android_keyevent",
        "description": "Send an Android keyevent through adb shell input keyevent",
        "parameters": {
            "type": "object",
            "properties": {
                "keycode": {"type": "number", "description": "Android keycode number, for example 3=HOME, 4=BACK, 66=ENTER, 224=WAKEUP"}
            },
            "required": ["keycode"]
        }
    },
    {
        "name": "android_current_app",
        "description": "Get the current foreground package/activity on the Android device",
        "parameters": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "android_launch_app",
        "description": "Launch an Android app by package name, optionally with a specific activity",
        "parameters": {
            "type": "object",
            "properties": {
                "packageName": {"type": "string", "description": "Android package name, for example com.android.settings"},
                "activity": {"type": "string", "description": "Optional full activity name, for example com.android.settings/.Settings"}
            },
            "required": ["packageName"]
        }
    },
    {
        "name": "android_stop_app",
        "description": "Force-stop an Android app by package name",
        "parameters": {
            "type": "object",
            "properties": {
                "packageName": {"type": "string", "description": "Android package name to stop"}
            },
            "required": ["packageName"]
        }
    },
    {
        "name": "android_shell",
        "description": "Execute an arbitrary adb shell command on the Android device and return its output",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The shell command to execute on the device"},
                "timeout": {"type": "number", "description": "Timeout in seconds (default: 10)", "default": 10}
            },
            "required": ["command"]
        }
    }
]


class AndroidNode:
    def __init__(self, device_serial: str = None):
        """Initialize Android Node with device connection"""
        self.device = u2.connect(device_serial)
        self.device_info = self.device.info
        logger.info(f"Connected to device: {self.device_info}")

    def adb_shell(self, command: str, check: bool = True) -> str:
        """Run adb shell command against the current device"""
        serial = getattr(self.device, "serial", None) or getattr(self.device, "_serial", None)
        cmd = ["adb"]
        if serial:
            cmd.extend(["-s", serial])
        cmd.extend(["shell", *shlex.split(command)])
        result = subprocess.run(cmd, capture_output=True, text=True)
        if check and result.returncode != 0:
            raise RuntimeError(
                f"adb shell failed: {command}\nstdout={result.stdout}\nstderr={result.stderr}"
            )
        return (result.stdout + result.stderr).strip()

    def get_unlock_state(self) -> Dict[str, Any]:
        """Collect a few lockscreen signals for diagnostics"""
        window_dump = self.adb_shell("dumpsys window", check=False)
        activity_dump = self.adb_shell("dumpsys activity activities", check=False)

        current_focus = ""
        for line in window_dump.splitlines():
            if "mCurrentFocus=" in line:
                current_focus = line.strip()
                break

        top_activity = ""
        for line in activity_dump.splitlines():
            if "topResumedActivity" in line or "mResumedActivity" in line:
                top_activity = line.strip()
                break

        dreaming_lockscreen = "mDreamingLockscreen=true" in window_dump
        keyguard_visible = "keyguard" in window_dump.lower() or "AlternateBouncerView" in window_dump
        launcher_resumed = "launcher" in top_activity.lower()
        unlocked = (not dreaming_lockscreen) and (launcher_resumed or (not keyguard_visible))

        return {
            "unlocked": unlocked,
            "dreamingLockscreen": dreaming_lockscreen,
            "currentFocus": current_focus,
            "topActivity": top_activity,
        }
        
    async def handle_tool_call(self, tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """Handle tool call from Foxwarm"""
        try:
            if tool == "android_tap":
                return await self.tap(args)
            elif tool == "android_swipe":
                return await self.swipe(args)
            elif tool == "android_input":
                return await self.input_text(args)
            elif tool == "android_screenshot":
                return await self.screenshot(args)
            elif tool == "android_get_ui_tree":
                return await self.get_ui_tree(args)
            elif tool == "android_list_elements":
                return await self.list_elements(args)
            elif tool == "android_unlock":
                return await self.unlock(args)
            elif tool == "android_keyevent":
                return await self.keyevent(args)
            elif tool == "android_current_app":
                return await self.current_app(args)
            elif tool == "android_launch_app":
                return await self.launch_app(args)
            elif tool == "android_stop_app":
                return await self.stop_app(args)
            elif tool == "android_shell":
                return await self.shell(args)
            else:
                return {"error": f"Unknown tool: {tool}"}
        except Exception as e:
            logger.error(f"Tool call error: {e}")
            return {"error": str(e)}
    
    async def tap(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Tap at coordinates or on UI element"""
        if "x" in args and "y" in args:
            self.device.click(args["x"], args["y"])
            return {"success": True, "action": "tap", "x": args["x"], "y": args["y"]}
        elif "text" in args:
            self.device(text=args["text"]).click()
            return {"success": True, "action": "tap", "text": args["text"]}
        elif "resourceId" in args:
            self.device(resourceId=args["resourceId"]).click()
            return {"success": True, "action": "tap", "resourceId": args["resourceId"]}
        else:
            return {"error": "Missing tap target (x/y or text or resourceId)"}
    
    async def swipe(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Swipe gesture"""
        fx = args.get("fx", args.get("x1", 0))
        fy = args.get("fy", args.get("y1", 0))
        tx = args.get("tx", args.get("x2", 0))
        ty = args.get("ty", args.get("y2", 0))
        duration = args.get("duration", 0.5)

        if fx == 0 and fy == 0 and tx == 0 and ty == 0:
            return {
                "error": "Missing swipe coordinates. Provide fx/fy/tx/ty or x1/y1/x2/y2."
            }
        
        self.device.swipe(fx, fy, tx, ty, duration=duration)
        return {"success": True, "action": "swipe", "from": [fx, fy], "to": [tx, ty]}
    
    async def input_text(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Input text"""
        text = args.get("text", "")
        self.device.send_keys(text)
        return {"success": True, "action": "input", "text": text}
    
    async def screenshot(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Capture screenshot"""
        inline = bool(args.get("inline"))
        output_path = args.get("path", "/tmp/screenshot.png")

        if inline:
            fd, temp_path = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            try:
                self.device.screenshot(temp_path)
                with Image.open(temp_path) as image:
                    rgb = image.convert("RGB")
                    out_fd, out_path = tempfile.mkstemp(suffix=".jpg")
                    os.close(out_fd)
                    try:
                        rgb.save(out_path, format="JPEG", quality=80, optimize=True)
                        with open(out_path, "rb") as f:
                            data = f.read()
                    finally:
                        if os.path.exists(out_path):
                            os.unlink(out_path)

                mime_type = "image/jpeg"
                encoded = base64.b64encode(data).decode("ascii")
                result = {
                    "success": True,
                    "action": "screenshot",
                    "output": "[Screenshot captured]",
                    "mimeType": mime_type,
                    "sizeBytes": len(data),
                    "inlineData": {
                        "data": encoded,
                        "mimeType": mime_type,
                    },
                }
                if args.get("path"):
                    self.device.screenshot(output_path)
                    result["path"] = output_path
                return result
            finally:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)

        self.device.screenshot(output_path)
        return {"success": True, "action": "screenshot", "path": output_path}
    
    async def get_ui_tree(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Get UI hierarchy"""
        xml = self.device.dump_hierarchy()
        return {"success": True, "action": "get_ui_tree", "xml": xml}

    async def list_elements(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """List simplified visible UI elements"""
        xml = self.device.dump_hierarchy()
        clickable_only = bool(args.get("clickableOnly"))
        limit = int(args.get("limit", 200))
        limit = max(1, min(limit, 1000))

        root = ET.fromstring(xml)
        elements = []

        def parse_bounds(bounds: str):
            try:
                left_top, right_bottom = bounds.strip("[]").split("][")
                left, top = [int(x) for x in left_top.split(",")]
                right, bottom = [int(x) for x in right_bottom.split(",")]
                return {
                    "left": left,
                    "top": top,
                    "right": right,
                    "bottom": bottom,
                    "centerX": (left + right) // 2,
                    "centerY": (top + bottom) // 2,
                }
            except Exception:
                return None

        for node in root.iter("node"):
            if len(elements) >= limit:
                break
            visible = node.attrib.get("visible-to-user", "true") == "true"
            clickable = node.attrib.get("clickable", "false") == "true"
            enabled = node.attrib.get("enabled", "true") == "true"
            text = node.attrib.get("text", "")
            content_desc = node.attrib.get("content-desc", "")
            resource_id = node.attrib.get("resource-id", "")
            class_name = node.attrib.get("class", "")

            if not visible:
                continue
            if clickable_only and not clickable:
                continue
            if not any([text, content_desc, resource_id, clickable]):
                continue

            elements.append({
                "text": text,
                "contentDesc": content_desc,
                "resourceId": resource_id,
                "className": class_name,
                "clickable": clickable,
                "enabled": enabled,
                "bounds": parse_bounds(node.attrib.get("bounds", "")),
            })

        return {
            "success": True,
            "action": "list_elements",
            "count": len(elements),
            "elements": elements,
        }

    async def keyevent(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Send Android keyevent"""
        keycode = args.get("keycode")
        if keycode is None:
            return {"error": "Missing keycode"}
        try:
            keycode = int(keycode)
        except Exception:
            return {"error": "keycode must be an integer"}

        self.adb_shell(f"input keyevent {keycode}", check=False)
        await asyncio.sleep(0.15)
        return {"success": True, "action": "keyevent", "keycode": keycode}

    async def current_app(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Get current foreground app/activity"""
        state = self.get_unlock_state()
        package_name = self.device.info.get("currentPackageName")
        return {
            "success": True,
            "action": "current_app",
            "packageName": package_name,
            "currentFocus": state.get("currentFocus"),
            "topActivity": state.get("topActivity"),
            "unlocked": state.get("unlocked") or package_name != "com.android.systemui",
        }

    async def launch_app(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Launch app by package name or explicit activity"""
        package_name = args.get("packageName")
        activity = args.get("activity")
        if not package_name:
            return {"error": "Missing packageName"}

        if activity:
            output = self.adb_shell(f"am start -n {activity}", check=False)
        else:
            output = self.adb_shell(f"monkey -p {package_name} -c android.intent.category.LAUNCHER 1", check=False)
        await asyncio.sleep(0.8)

        return {
            "success": True,
            "action": "launch_app",
            "packageName": package_name,
            "activity": activity,
            "output": output,
            "state": await self.current_app({}),
        }

    async def stop_app(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Force-stop app by package name"""
        package_name = args.get("packageName")
        if not package_name:
            return {"error": "Missing packageName"}

        output = self.adb_shell(f"am force-stop {package_name}", check=False)
        await asyncio.sleep(0.5)
        return {
            "success": True,
            "action": "stop_app",
            "packageName": package_name,
            "output": output,
            "state": await self.current_app({}),
        }

    async def shell(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Execute an arbitrary adb shell command"""
        command = args.get("command")
        if not command:
            return {"error": "Missing command"}
        timeout = int(args.get("timeout", 10))
        timeout = max(1, min(timeout, 120))

        serial = getattr(self.device, "serial", None) or getattr(self.device, "_serial", None)
        cmd = ["adb"]
        if serial:
            cmd.extend(["-s", serial])
        cmd.extend(["shell", command])

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout
            )
            output = (result.stdout + result.stderr).strip()
            return {
                "success": True,
                "action": "shell",
                "command": command,
                "exitCode": result.returncode,
                "output": output,
            }
        except subprocess.TimeoutExpired:
            return {"error": f"Command timed out after {timeout}s", "command": command}

    async def unlock(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Wake device and unlock with numeric PIN"""
        pin = str(args.get("pin", ""))
        if not pin or not pin.isdigit():
            return {"error": "PIN must be a numeric string"}

        before = self.get_unlock_state()
        attempt_results = []

        self.adb_shell("svc power stayon usb", check=False)

        async def press_pin_keyevents():
            for ch in pin:
                self.adb_shell(f"input keyevent {7 + int(ch)}", check=False)
                await asyncio.sleep(0.12)
            self.adb_shell("input keyevent 66", check=False)

        async def press_pin_text():
            self.adb_shell(f"input text {pin}", check=False)
            await asyncio.sleep(0.15)
            self.adb_shell("input keyevent 66", check=False)

        attempts = [
            ("swipe_keyevents", [
                "input keyevent 224",
                "cmd statusbar collapse",
                "input swipe 540 2200 540 700 180",
            ], press_pin_keyevents),
            ("dismiss_keyevents", [
                "input keyevent 224",
                "wm dismiss-keyguard",
                "cmd statusbar collapse",
            ], press_pin_keyevents),
            ("dismiss_text", [
                "input keyevent 224",
                "wm dismiss-keyguard",
                "cmd statusbar collapse",
            ], press_pin_text),
            ("menu_keyevents", [
                "input keyevent 224",
                "input keyevent 82",
                "cmd statusbar collapse",
            ], press_pin_keyevents),
            ("swipe_dismiss_keyevents", [
                "input keyevent 224",
                "cmd statusbar collapse",
                "input swipe 540 2200 540 700 180",
                "wm dismiss-keyguard",
            ], press_pin_keyevents),
        ]

        for name, pre_cmds, pin_fn in attempts:
            for cmd in pre_cmds:
                self.adb_shell(cmd, check=False)
                await asyncio.sleep(0.35)

            verify_output = self.adb_shell(f"cmd lock_settings verify --old {pin}", check=False)
            self.adb_shell("cmd statusbar collapse", check=False)
            await asyncio.sleep(0.35)

            after_verify = self.get_unlock_state()
            if after_verify["unlocked"]:
                attempt_results.append({
                    "attempt": name,
                    "verifyOutput": verify_output,
                    "afterVerify": after_verify,
                    "success": True,
                    "stage": "verify",
                })
                return {
                    "success": True,
                    "action": "unlock",
                    "method": name,
                    "before": before,
                    "after": after_verify,
                    "attempts": attempt_results,
                }

            await pin_fn()
            await asyncio.sleep(1.0)
            self.adb_shell("cmd statusbar collapse", check=False)
            await asyncio.sleep(0.2)

            after = self.get_unlock_state()
            success = after["unlocked"]
            attempt_results.append({
                "attempt": name,
                "verifyOutput": verify_output,
                "after": after,
                "success": success,
                "stage": "pin",
            })
            if success:
                return {
                    "success": True,
                    "action": "unlock",
                    "method": name,
                    "before": before,
                    "after": after,
                    "attempts": attempt_results,
                }

        return {
            "success": False,
            "action": "unlock",
            "method": "exhausted",
            "before": before,
            "after": self.get_unlock_state(),
            "attempts": attempt_results,
        }


def build_registration_payload(node: AndroidNode) -> Dict[str, Any]:
    return {
        "type": "node_register",
        "nodeType": "android",
        "capabilities": {
            "tools": TOOL_DEFINITIONS
        },
        "metadata": {
            "version": "1.0.0",
            "platform": "android",
            "device": node.device_info
        }
    }


async def connect_to_foxwarm(node: AndroidNode):
    """Connect to foxwarm using pairing-based auth or stored credentials."""
    config = parse_connection_config()
    if not config:
        raise RuntimeError("Missing FOXWARM host configuration")

    connected_node_id = config.node_id
    auth_token = config.auth_token
    pairing_token = config.pairing_token
    pairing_rejected = False
    force_immediate_reconnect = False

    stored = load_stored_credentials(config.credentials_file)
    if stored and not (connected_node_id and auth_token):
        connected_node_id = stored.node_id
        auth_token = stored.auth_token

    if not pairing_token and not (connected_node_id and auth_token):
        raise RuntimeError("Need pairing token or stored node credentials")

    while True:
        mode = "authenticated" if connected_node_id and auth_token else "pairing"
        ws_url = build_node_ws_url(
            config.host,
            pairing_token=pairing_token if mode == "pairing" else None,
            node_id=connected_node_id if mode == "authenticated" else None,
            auth_token=auth_token if mode == "authenticated" else None,
        )
        logger.info(
            "Connecting to foxwarm at %s (mode=%s, requested=%s, node_id=%s)",
            ws_url,
            mode,
            config.requested_name,
            connected_node_id,
        )

        try:
            async with websockets.connect(
                ws_url,
                ping_interval=ANDROID_NODE_PING_INTERVAL,
                ping_timeout=ANDROID_NODE_PING_TIMEOUT,
            ) as websocket:
                if mode == "authenticated":
                    logger.info("Sending node registration...")
                    await websocket.send(json.dumps(build_registration_payload(node)))
                else:
                    logger.info("Sending pair request...")
                    await websocket.send(json.dumps({
                        "type": "pair_request",
                        "requestedName": config.requested_name,
                        "nodeType": "android",
                        "capabilities": {"tools": TOOL_DEFINITIONS},
                    }))

                async for message in websocket:
                    data = json.loads(message)
                    message_type = data.get("type")

                    if message_type == "registered":
                        connected_node_id = data.get("nodeId") or connected_node_id
                        logger.info("✅ Successfully registered as node: %s", connected_node_id)
                        continue

                    if message_type == "pair_pending":
                        logger.info(
                            "⏳ Pairing pending approval: pendingId=%s pairCode=%s requested=%s",
                            data.get("pendingId"),
                            data.get("pairCode"),
                            data.get("requestedName"),
                        )
                        continue

                    if message_type == "pair_approved":
                        connected_node_id = str(data.get("nodeId"))
                        auth_token = str(data.get("authToken"))
                        save_stored_credentials(
                            config.credentials_file,
                            connected_node_id,
                            auth_token,
                            int(data.get("pairedAt") or int(time.time() * 1000)),
                        )
                        logger.info("✅ Pairing approved for node: %s", connected_node_id)
                        force_immediate_reconnect = True
                        await websocket.close(reason="Reconnect with node credentials")
                        break

                    if message_type == "pair_rejected":
                        logger.error("❌ Pairing rejected: %s", data.get("reason"))
                        pairing_rejected = True
                        break

                    if message_type == "tool_call":
                        tool_name = data.get("tool")
                        args = data.get("args", {})
                        call_id = data.get("callId") or data.get("id")
                        logger.info("Executing tool: %s", tool_name)
                        result = await node.handle_tool_call(tool_name, args)
                        await websocket.send(json.dumps({
                            "type": "tool_call_response",
                            "callId": call_id,
                            "result": result,
                        }))
                        continue

        except websockets.exceptions.ConnectionClosed as e:
            logger.warning("Connection closed: code=%s reason=%s", e.code, e.reason)
            if e.code == 1008 and "Invalid node credentials" in str(e.reason) and pairing_token:
                clear_stored_credentials(config.credentials_file)
                connected_node_id = None
                auth_token = None
        except Exception as e:
            logger.error("Connection error: %s", e)

        if pairing_rejected:
            return

        await asyncio.sleep(0.25 if force_immediate_reconnect else 5)
        force_immediate_reconnect = False


async def websocket_handler(websocket, path, node: AndroidNode):
    """Handle WebSocket connection (legacy mode)"""
    logger.info(f"WebSocket connected: {path}")
    
    try:
        async for message in websocket:
            data = json.loads(message)
            tool = data.get("tool")
            args = data.get("args", {})
            
            result = await node.handle_tool_call(tool, args)
            await websocket.send(json.dumps(result))
    except websockets.exceptions.ConnectionClosed:
        logger.info("WebSocket connection closed")


async def http_handler(request):
    """Handle HTTP tool calls (legacy mode)"""
    data = await request.json()
    tool = data.get("tool")
    args = data.get("args", {})
    
    node = request.app["node"]
    result = await node.handle_tool_call(tool, args)
    
    return web.json_response(result)


async def main():
    """Start Android Node server"""
    # Initialize Android Node
    device_serial = os.getenv("ANDROID_DEVICE_SERIAL")
    node = AndroidNode(device_serial)
    
    # Check if the node should connect to Foxwarm
    connection_config = parse_connection_config()

    if connection_config:
        logger.info("🚀 Starting in foxwarm pairing/auth mode")
        await connect_to_foxwarm(node)
    else:
        # Legacy standalone mode
        logger.info("🚀 Starting in standalone mode (HTTP + WebSocket)")
        
        # Start HTTP server
        app = web.Application()
        app["node"] = node
        app.router.add_post("/tool", http_handler)
        
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", 8765)
        await site.start()
        
        logger.info("Android Node server started on http://0.0.0.0:8765")
        logger.info("WebSocket server started on ws://0.0.0.0:8766")
        
        # Start WebSocket server
        async with websockets.serve(
            lambda ws, path: websocket_handler(ws, path, node),
            "0.0.0.0",
            8766
        ):
            await asyncio.Future()  # Run forever


if __name__ == "__main__":
    asyncio.run(main())
