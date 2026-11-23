using AppKit;
using CoreGraphics;
using Foundation;
using WebKit;

namespace Foxwarm.Desktop;

// The native instance menu: the local instance (with its stop button), the remote instances
// (each with a remove button) and adding a remote by URL. The brand row pops it up; the
// Instances menu in the menu bar shows the same items.
internal sealed partial class DesktopApplication
{
    private bool sheetOpen;

    private NSAppearance Appearance =>
        NSAppearance.GetAppearance(frame?.Dark == true ? NSAppearance.NameDarkAqua : NSAppearance.NameAqua);

    private void FillInstancesMenu(NSMenu menu)
    {
        menu.RemoveAllItems();
        menu.AutoEnablesItems = false;
        if (instances is null)
        {
            menu.AddItem(new NSMenuItem("Local") { Enabled = false });
            return;
        }
        var running = host is not null && !stoppingLocal;
        menu.AddItem(Row(
            "Local",
            instances.Selected is null,
            "desktopcomputer",
            running ? ("stop.circle", "Stop Local Instance", () => _ = StopLocalAsync()) : null,
            () => _ = SwitchAsync(null)
        ));
        foreach (var remote in instances.Remotes)
        {
            var selected = instances.Selected == remote;
            menu.AddItem(Row(
                DesktopInstances.Label(remote),
                selected,
                "globe",
                selected ? null : ("xmark.circle", "Remove", () => instances.Remove(remote)),
                () => _ = SwitchAsync(remote)
            ));
        }
        menu.AddItem(NSMenuItem.SeparatorItem);
        menu.AddItem(new NSMenuItem("Add Remote Instance…", (_, _) => _ = AddRemoteAsync()));
    }

    private static NSMenuItem Row(
        string title,
        bool selected,
        string symbol,
        (string Symbol, string Tip, Action Action)? trailing,
        Action activate
    )
    {
        // The item's own action answers Return when it is highlighted from the keyboard.
        var item = new NSMenuItem(title, (_, _) => activate());
        item.View = new InstanceMenuRow(title, selected, symbol, trailing, activate);
        return item;
    }

    /// <summary>Below the brand row's rectangle, in the page's CSS px (the web view's points).</summary>
    private void ShowInstanceMenu(WKWebView webView, FrameRect anchor)
    {
        // Not inside the script message callback: the menu tracks in its own loop.
        NSApplication.SharedApplication.BeginInvokeOnMainThread(() =>
        {
            if (exiting || sheetOpen || webView.Window is null)
                return;
            var menu = new NSMenu { Appearance = Appearance };
            FillInstancesMenu(menu);
            var y = webView.IsFlipped ? anchor.Bottom + 4 : webView.Bounds.Height - anchor.Bottom - 4;
            menu.PopUpMenu(null, new CGPoint(anchor.X, y), webView);
        });
    }

    private void ShowInstanceMenu(NSView button)
    {
        if (exiting || sheetOpen)
            return;
        var menu = new NSMenu { Appearance = Appearance };
        FillInstancesMenu(menu);
        menu.PopUpMenu(null, new CGPoint(0, button.IsFlipped ? button.Bounds.Height + 4 : -4), button);
    }

    private async Task AddRemoteAsync()
    {
        if (window is null || instances is null || sheetOpen || exiting)
            return;
        OpenWindow();
        var field = new NSTextField(new CGRect(0, 0, 320, 24))
        {
            PlaceholderString = "https://example.com/foxwarm/",
        };
        using var alert = new NSAlert { MessageText = "Add Remote Instance", AccessoryView = field };
        alert.Window.Appearance = Appearance;
        alert.AddButton("Add");
        alert.AddButton("Cancel");
        alert.Window.InitialFirstResponder = field;
        Uri? url = null;
        sheetOpen = true;
        try
        {
            while (url is null)
            {
                if ((long)await alert.BeginSheetAsync(window) != 1000)
                    return;
                url = DesktopInstances.Normalize(field.StringValue);
                if (url is null)
                    alert.InformativeText = "Enter an http or https address.";
            }
        }
        finally
        {
            sheetOpen = false;
        }
        if (!exiting)
            await SwitchAsync(instances.Add(url));
    }

    private async Task<bool> ConfirmStopAsync(int running)
    {
        if (window is null || sheetOpen)
            return false;
        OpenWindow();
        using var alert = new NSAlert
        {
            MessageText = "Stop the local instance?",
            InformativeText = DesktopInstances.RunningSessionsText(running),
        };
        alert.Window.Appearance = Appearance;
        alert.AddButton("Stop");
        alert.AddButton("Cancel");
        sheetOpen = true;
        try
        {
            return (long)await alert.BeginSheetAsync(window) == 1000;
        }
        finally
        {
            sheetOpen = false;
        }
    }

    /// <summary>Rebuilds the menu bar's Instances menu each time it opens.</summary>
    private sealed class InstancesMenuUpdater(DesktopApplication owner) : NSMenuDelegate
    {
        public override void MenuWillHighlightItem(NSMenu menu, NSMenuItem item) { }

        [Export("menuNeedsUpdate:")]
        public void MenuNeedsUpdate(NSMenu menu) => owner.FillInstancesMenu(menu);
    }
}

/// <summary>
/// A menu row drawn like a standard item (a check for the current instance, an icon and the
/// title) with an optional trailing icon button, which standard menu items can't have.
/// </summary>
internal sealed class InstanceMenuRow : NSView
{
    private const double Width = 280;
    private const double Height = 24;
    private readonly NSTextField label;
    private readonly NSImageView check;
    private readonly NSImageView icon;
    private readonly NSButton? button;
    private readonly Action activate;
    private readonly Action? trailingAction;

    internal InstanceMenuRow(
        string title,
        bool selected,
        string symbol,
        (string Symbol, string Tip, Action Action)? trailing,
        Action activate
    )
        : base(new CGRect(0, 0, Width, Height))
    {
        this.activate = activate;
        AutoresizingMask = NSViewResizingMask.WidthSizable;
        check = NSImageView.FromImage(NSImage.GetSystemSymbol("checkmark", null)!);
        check.Frame = new CGRect(12, 4, 14, 16);
        check.Hidden = !selected;
        icon = NSImageView.FromImage(NSImage.GetSystemSymbol(symbol, null)!);
        icon.Frame = new CGRect(30, 3, 18, 18);
        label = NSTextField.CreateLabel(title);
        label.Font = NSFont.MenuFontOfSize(0);
        label.LineBreakMode = NSLineBreakMode.TruncatingMiddle;
        label.Frame = new CGRect(54, 3, Width - 54 - (trailing is null ? 12 : 40), 18);
        label.AutoresizingMask = NSViewResizingMask.WidthSizable;
        AddSubview(check);
        AddSubview(icon);
        AddSubview(label);
        if (trailing is { } action)
        {
            trailingAction = action.Action;
            button = NSButton.CreateButton(NSImage.GetSystemSymbol(action.Symbol, action.Tip)!, Trailing);
            button.Bordered = false;
            button.ToolTip = action.Tip;
            button.SetAccessibilityLabel(action.Tip);
            button.Frame = new CGRect(Width - 36, 1, 26, 22);
            button.AutoresizingMask = NSViewResizingMask.MinXMargin;
            AddSubview(button);
        }
        SetAccessibilityElement(true);
        SetAccessibilityRole(NSAccessibilityRoles.MenuItemRole);
        SetAccessibilityLabel(selected ? title + ", current" : title);
    }

    private bool Highlighted => EnclosingMenuItem?.Highlighted == true;

    public override void DrawRect(CGRect dirtyRect)
    {
        var highlighted = Highlighted;
        if (highlighted)
        {
            NSColor.SelectedContentBackgroundColor.SetFill();
            NSBezierPath.FromRoundedRect(new CGRect(5, 0, Bounds.Width - 10, Bounds.Height), 4, 4).Fill();
        }
        var color = highlighted ? NSColor.SelectedMenuItemText : NSColor.LabelColor;
        if (label.TextColor != color)
            label.TextColor = color;
        check.ContentTintColor = color;
        icon.ContentTintColor = highlighted ? color : NSColor.SecondaryLabel;
        if (button is not null)
            button.ContentTintColor = highlighted ? color : NSColor.SecondaryLabel;
        base.DrawRect(dirtyRect);
    }

    public override void MouseUp(NSEvent theEvent) => Run(activate);

    private void Trailing()
    {
        if (trailingAction is not null)
            Run(trailingAction);
    }

    // Closes the menu first; the action runs once its tracking loop has ended.
    private void Run(Action action)
    {
        EnclosingMenuItem?.Menu?.CancelTracking();
        NSApplication.SharedApplication.BeginInvokeOnMainThread(action);
    }
}
