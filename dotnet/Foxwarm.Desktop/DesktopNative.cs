using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Windows.Graphics;

namespace Foxwarm.Desktop;

// WinUI owns the window and dispatcher; these Win32 APIs supply its tray and session messages.
internal sealed class DesktopNative : IDisposable
{
    private const uint TrayMessage = 0x8001;
    private readonly nint hwnd;
    private readonly uint taskbarCreatedMessage;
    private readonly SubclassProcedure procedure;
    private readonly Action open;
    private readonly Action exit;
    private readonly Action shutdown;
    private readonly Action instances;
    private readonly nint icon;
    private NotifyIconData tray;
    private bool disposed;
    private const int ShortcutId = 1;

    internal DesktopNative(DesktopWindow window, Action open, Action exit, Action shutdown, Action instances)
    {
        this.instances = instances;
        this.open = open;
        this.exit = exit;
        this.shutdown = shutdown;
        hwnd = WinRT.Interop.WindowNative.GetWindowHandle(window);
        taskbarCreatedMessage = RegisterWindowMessage("TaskbarCreated");
        if (taskbarCreatedMessage == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        procedure = WindowProcedure;
        if (!SetWindowSubclass(hwnd, procedure, 1, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        var iconPath = Path.Combine(AppContext.BaseDirectory, "Foxwarm.ico");
        window.AppWindow.SetIcon(iconPath);
        var area = DisplayArea.GetFromWindowId(window.AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var width = Math.Min(1280, area.Width);
        var height = Math.Min(860, area.Height);
        window.AppWindow.MoveAndResize(new RectInt32(
            area.X + (area.Width - width) / 2,
            area.Y + (area.Height - height) / 2,
            width,
            height
        ));
        icon = LoadImage(0, iconPath, 1, 0, 0, 0x10 | 0x40);
        if (icon == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        tray = new NotifyIconData
        {
            Size = (uint)Marshal.SizeOf<NotifyIconData>(),
            Window = hwnd,
            Id = 1,
            Flags = 1 | 2 | 4,
            CallbackMessage = TrayMessage,
            Icon = icon,
            Tip = "Foxwarm",
            Info = "",
            InfoTitle = "",
        };
        if (!ShellNotifyIcon(0, ref tray))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    internal void Foreground() => SetForegroundWindow(hwnd);

    private bool shortcut;

    /// <summary>Ctrl+Shift+F1 opens the instance menu while the window is active; another app may own it.</summary>
    internal void ActivateShortcut(bool active)
    {
        if (disposed || active == shortcut)
            return;
        shortcut = active;
        if (active)
            RegisterHotKey(hwnd, ShortcutId, 0x2 | 0x4 | 0x4000, 0x70); // MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_F1
        else
            UnregisterHotKey(hwnd, ShortcutId);
    }

    internal static void ShowMessage(string text) => MessageBox(0, text, "Foxwarm", 0x40);

    private nint WindowProcedure(nint window, uint message, nuint wParam, nint lParam, nuint id, nuint data)
    {
        if (message == taskbarCreatedMessage)
        {
            // Explorer recreates the taskbar without retaining notification icons.
            if (!disposed)
                ShellNotifyIcon(0, ref tray);
            return 0;
        }

        switch (message)
        {
            case TrayMessage:
                if ((uint)lParam == 0x203) // WM_LBUTTONDBLCLK
                    open();
                else if ((uint)lParam == 0x205) // WM_RBUTTONUP
                    ShowMenu();
                return 0;
            case 0x24: // WM_GETMINMAXINFO
                var bounds = Marshal.PtrToStructure<MinMaxInfo>(lParam);
                var scale = GetDpiForWindow(hwnd) / 96.0;
                bounds.MinTrackSize = new Point { X = (int)(800 * scale), Y = (int)(600 * scale) };
                Marshal.StructureToPtr(bounds, lParam, false);
                return 0;
            case 0x312 when wParam == ShortcutId: // WM_HOTKEY
                instances();
                return 0;
            case 0x11: // WM_QUERYENDSESSION: do not veto Windows shutdown.
                return 1;
            case 0x16: // WM_ENDSESSION
                if (wParam != 0)
                    shutdown();
                break;
        }
        return DefSubclassProc(window, message, wParam, lParam);
    }

    private void ShowMenu()
    {
        var menu = CreatePopupMenu();
        try
        {
            AppendMenu(menu, 0, 1, "Open");
            AppendMenu(menu, 0, 3, "Switch instance…");
            AppendMenu(menu, 0x800, 0, null); // MF_SEPARATOR
            AppendMenu(menu, 0, 2, "Exit");
            GetCursorPos(out var point);
            SetForegroundWindow(hwnd);
            var selected = TrackPopupMenu(menu, 0x100 | 0x2, point.X, point.Y, 0, hwnd, 0);
            PostMessage(hwnd, 0, 0, 0);
            if (selected == 1)
                open();
            else if (selected == 2)
                exit();
            else if (selected == 3)
                instances();
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    public void Dispose()
    {
        if (disposed)
            return;
        ActivateShortcut(false);
        disposed = true;
        ShellNotifyIcon(2, ref tray);
        RemoveWindowSubclass(hwnd, procedure, 1);
        DestroyIcon(icon);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint Size;
        public nint Window;
        public uint Id, Flags, CallbackMessage;
        public nint Icon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Tip;
        public uint State, StateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Info;
        public uint Timeout;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string InfoTitle;
        public uint InfoFlags;
        public Guid Guid;
        public nint BalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate nint SubclassProcedure(nint hwnd, uint message, nuint wParam, nint lParam, nuint id, nuint data);

    [DllImport("comctl32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowSubclass(nint hwnd, SubclassProcedure procedure, nuint id, nuint data);

    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RemoveWindowSubclass(nint hwnd, SubclassProcedure procedure, nuint id);

    [DllImport("comctl32.dll")]
    private static extern nint DefSubclassProc(nint hwnd, uint message, nuint wParam, nint lParam);

    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShellNotifyIcon(uint operation, ref NotifyIconData data);

    [DllImport("user32.dll", EntryPoint = "LoadImageW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint LoadImage(nint instance, string name, uint type, int width, int height, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(nint icon);

    [DllImport("user32.dll", EntryPoint = "MessageBoxW", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(nint hwnd, string text, string title, uint type);

    [DllImport("user32.dll")]
    private static extern nint CreatePopupMenu();

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint key);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnregisterHotKey(nint window, int id);

    [DllImport("user32.dll", EntryPoint = "AppendMenuW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AppendMenu(nint menu, uint flags, nuint id, string? text);

    [DllImport("user32.dll")]
    private static extern uint TrackPopupMenu(nint menu, uint flags, int x, int y, int reserved, nint hwnd, nint rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyMenu(nint menu);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint hwnd);

    [DllImport("user32.dll", EntryPoint = "PostMessageW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessage(nint hwnd, uint message, nuint wParam, nint lParam);

    [DllImport("user32.dll", EntryPoint = "RegisterWindowMessageW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterWindowMessage(string message);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(nint hwnd);
}
