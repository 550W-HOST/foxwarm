#!/usr/bin/env python3
"""
Test script for Android Node
"""

import asyncio
import json
from aiohttp import ClientSession


async def test_android_node():
    """Test Android Node tools"""
    base_url = "http://localhost:8765"
    
    async with ClientSession() as session:
        print("🧪 Testing Android Node...")
        
        # Test 1: Screenshot
        print("\n1. Testing screenshot...")
        async with session.post(f"{base_url}/tool", json={
            "tool": "android_screenshot",
            "args": {"path": "/tmp/test_screenshot.png"}
        }) as resp:
            result = await resp.json()
            print(f"   Result: {result}")
            assert result.get("success"), "Screenshot failed"
        
        # Test 2: Get UI Tree
        print("\n2. Testing get_ui_tree...")
        async with session.post(f"{base_url}/tool", json={
            "tool": "android_get_ui_tree",
            "args": {}
        }) as resp:
            result = await resp.json()
            print(f"   Result: UI tree length = {len(result.get('xml', ''))}")
            assert result.get("success"), "Get UI tree failed"
        
        # Test 3: Tap (coordinates)
        print("\n3. Testing tap (coordinates)...")
        async with session.post(f"{base_url}/tool", json={
            "tool": "android_tap",
            "args": {"x": 500, "y": 500}
        }) as resp:
            result = await resp.json()
            print(f"   Result: {result}")
            assert result.get("success"), "Tap failed"
        
        # Test 4: Swipe
        print("\n4. Testing swipe...")
        async with session.post(f"{base_url}/tool", json={
            "tool": "android_swipe",
            "args": {"fx": 500, "fy": 1000, "tx": 500, "ty": 500, "duration": 0.3}
        }) as resp:
            result = await resp.json()
            print(f"   Result: {result}")
            assert result.get("success"), "Swipe failed"
        
        # Test 5: Input text
        print("\n5. Testing input...")
        async with session.post(f"{base_url}/tool", json={
            "tool": "android_input",
            "args": {"text": "Hello Android Node"}
        }) as resp:
            result = await resp.json()
            print(f"   Result: {result}")
            assert result.get("success"), "Input failed"
        
        print("\n✅ All tests passed!")


if __name__ == "__main__":
    asyncio.run(test_android_node())
