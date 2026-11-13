# Observes and drives the Windows Desktop's own window and notification icon for the release
# acceptance (qualify-desktop-package.mjs). It touches only the windows of the given process.
#   window  -ProcessId N   the main WinUI window: handle, visibility and title
#   tray    -ProcessId N   whether Explorer has the process's notification icon
#   modules -ProcessId N   the loaded module names
#   close   -ProcessId N   the window's close request (WM_CLOSE)
#   open    -ProcessId N   a double-click notification from the icon
#   exit    -ProcessId N   opens the icon's menu and clicks its Exit item with the mouse
# Prints one JSON object.
param(
  [Parameter(Mandatory = $true)][ValidateSet('window', 'tray', 'modules', 'close', 'open', 'exit')][string]$Action,
  [Parameter(Mandatory = $true)][int]$ProcessId
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FoxwarmDesktopWindow
{
    public const uint TrayMessage = 0x8001;
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int size, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMenuItemRect(IntPtr hwnd, IntPtr menu, uint item, out Rect rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW")] static extern bool Shell_NotifyIcon(uint operation, ref NotifyIconData data);

    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct NotifyIconData
    {
        public uint Size; public IntPtr Window; public uint Id, Flags, CallbackMessage; public IntPtr Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint Timeout;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string InfoTitle;
        public uint InfoFlags; public Guid Item; public IntPtr BalloonIcon;
    }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }

    public static List<IntPtr> Windows(int processId, string className)
    {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, data) =>
        {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == processId && Class(hwnd) == className) found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string Class(IntPtr hwnd)
    {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }

    public static string Title(IntPtr hwnd)
    {
        var text = new StringBuilder(512);
        GetWindowText(hwnd, text, text.Capacity);
        return text.ToString();
    }

    // Whether Explorer has the icon the Desktop registered for its window with id 1: a modification
    // that changes nothing (no flags) succeeds only for an existing icon.
    public static bool TrayIcon(IntPtr hwnd)
    {
        var data = new NotifyIconData { Size = (uint)Marshal.SizeOf(typeof(NotifyIconData)), Window = hwnd, Id = 1, Tip = "", Info = "", InfoTitle = "" };
        return Shell_NotifyIcon(1, ref data); // NIM_MODIFY
    }


    public static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        var inputs = new Input[2];
        inputs[0].Type = 0; inputs[0].Mouse.Flags = 0x0002; // MOUSEEVENTF_LEFTDOWN
        inputs[1].Type = 0; inputs[1].Mouse.Flags = 0x0004; // MOUSEEVENTF_LEFTUP
        SendInput(2, inputs, Marshal.SizeOf(typeof(Input)));
    }
}
'@

function Write-Result($value) { $value | ConvertTo-Json -Compress -Depth 4 }

# The main window keeps existing while it is hidden in the tray.
function Get-MainWindow {
  $windows = [FoxwarmDesktopWindow]::Windows($ProcessId, 'WinUIDesktopWin32WindowClass')
  if ($windows.Count -ne 1) { throw "Expected one Desktop window for process $ProcessId, found $($windows.Count)" }
  $windows[0]
}

switch ($Action) {
  'window' {
    $hwnd = Get-MainWindow
    Write-Result @{ visible = [FoxwarmDesktopWindow]::IsWindowVisible($hwnd); title = [FoxwarmDesktopWindow]::Title($hwnd) }
  }
  'tray' { Write-Result @{ registered = [FoxwarmDesktopWindow]::TrayIcon((Get-MainWindow)) } }
  'modules' { Write-Result @{ modules = @((Get-Process -Id $ProcessId).Modules | ForEach-Object { $_.ModuleName }) } }
  'close' { Write-Result @{ posted = [FoxwarmDesktopWindow]::PostMessage((Get-MainWindow), 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero) } }
  'open' { Write-Result @{ posted = [FoxwarmDesktopWindow]::PostMessage((Get-MainWindow), [FoxwarmDesktopWindow]::TrayMessage, [UIntPtr]::new(1), [IntPtr]0x0203) } }
  'exit' {
    # WM_RBUTTONUP from the icon opens the native menu (TrackPopupMenu, window class #32768).
    $hwnd = Get-MainWindow
    [void][FoxwarmDesktopWindow]::PostMessage($hwnd, [FoxwarmDesktopWindow]::TrayMessage, [UIntPtr]::new(1), [IntPtr]0x0205)
    $deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 200
      $popup = @([FoxwarmDesktopWindow]::Windows($ProcessId, '#32768') | Where-Object { [FoxwarmDesktopWindow]::IsWindowVisible($_) }) | Select-Object -First 1
    } until ($popup -or (Get-Date) -gt $deadline)
    if (-not $popup) { throw 'The notification icon menu did not open' }
    $menu = [FoxwarmDesktopWindow]::SendMessage($popup, 0x01E1, [IntPtr]::Zero, [IntPtr]::Zero) # MN_GETHMENU
    $items = @()
    for ($i = 0; $i -lt [FoxwarmDesktopWindow]::GetMenuItemCount($menu); $i++) {
      $text = New-Object System.Text.StringBuilder 64
      [void][FoxwarmDesktopWindow]::GetMenuString($menu, $i, $text, 64, 0x400)
      $items += $text.ToString()
    }
    $index = [array]::IndexOf($items, 'Exit')
    if ($index -lt 0) { throw "The menu has no Exit item: $($items -join ', ')" }
    $rect = New-Object FoxwarmDesktopWindow+Rect
    if (-not [FoxwarmDesktopWindow]::GetMenuItemRect([IntPtr]::Zero, $menu, $index, [ref]$rect)) { throw 'The Exit item has no screen position' }
    [FoxwarmDesktopWindow]::Click([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2))
    Write-Result @{ items = $items; clicked = 'Exit' }
  }
}
