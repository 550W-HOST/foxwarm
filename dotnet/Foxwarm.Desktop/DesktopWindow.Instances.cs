using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace Foxwarm.Desktop;

// The native instance menu: a flyout with the local instance (and its stop button), the
// remote instances (each with a remove button) and adding a remote by URL.
internal sealed partial class DesktopWindow
{
    private Flyout? openMenu;
    private bool dialogOpen;

    private ElementTheme Theme => frame.Dark ? ElementTheme.Dark : ElementTheme.Light;

    /// <summary>
    /// Opens the menu in <paramref name="owner"/>: below the brand row's rectangle (page
    /// CSS px, which are the web view's DIPs at its origin), below a button, or at the top
    /// left where the brand row would be.
    /// </summary>
    private void OpenInstanceMenu(Window owner, FrameRect? anchor, FrameworkElement? button = null)
    {
        if (exiting || instances is null || dialogOpen || owner.Content is not FrameworkElement root || root.XamlRoot is null)
            return;
        openMenu?.Hide();
        var flyout = new Flyout { ShouldConstrainToRootBounds = false };
        var presenter = new Style(typeof(FlyoutPresenter));
        presenter.Setters.Add(new Setter(FrameworkElement.RequestedThemeProperty, Theme));
        presenter.Setters.Add(new Setter(Control.PaddingProperty, new Thickness(4)));
        presenter.Setters.Add(new Setter(FrameworkElement.MinWidthProperty, 0d));
        flyout.FlyoutPresenterStyle = presenter;
        var panel = new StackPanel
        {
            MinWidth = 280,
            MaxWidth = 420,
            Spacing = 2,
            RequestedTheme = Theme,
            XYFocusKeyboardNavigation = XYFocusKeyboardNavigationMode.Enabled,
        };
        AutomationProperties.SetName(panel, "Instances");
        var running = host is not null && !stoppingLocal;
        Control? current = null;
        panel.Children.Add(MenuRow(
            flyout,
            "\uE80F",
            "Local",
            instances.Selected is null,
            () => _ = SwitchAsync(null),
            running ? ("\uE7E8", "Stop local instance", () => _ = StopLocalAsync()) : null
        ));
        if (instances.Selected is null)
            current = (Control)((Grid)panel.Children[^1]).Children[0];
        foreach (var remote in instances.Remotes)
        {
            var selected = instances.Selected == remote;
            panel.Children.Add(MenuRow(
                flyout,
                "\uE774",
                DesktopInstances.Label(remote),
                selected,
                () => _ = SwitchAsync(remote),
                selected ? null : ("\uE711", "Remove", () => instances.Remove(remote))
            ));
            if (selected)
                current = (Control)((Grid)panel.Children[^1]).Children[0];
        }
        panel.Children.Add(new Border
        {
            Height = 1,
            Margin = new Thickness(8, 4, 8, 4),
            // App resources follow the app theme, not the page's; a neutral divider suits both.
            Background = new SolidColorBrush(Windows.UI.Color.FromArgb(0x33, 0x80, 0x80, 0x80)),
        });
        panel.Children.Add(MenuRow(flyout, "\uE710", "Add remote instance…", null, () => _ = AddRemoteAsync(), null));
        flyout.Content = panel;
        flyout.Closed += (_, _) =>
        {
            if (openMenu == flyout)
                openMenu = null;
        };
        openMenu = flyout;
        // Focus starts on the current instance. A click on the brand row or a button shows no
        // focus rectangle; the keyboard entries (shortcut, tray) do.
        var focus = anchor is null && button is null ? FocusState.Keyboard : FocusState.Pointer;
        flyout.Opened += (_, _) => current?.Focus(focus);
        if (button is not null)
            flyout.ShowAt(button, new FlyoutShowOptions { Placement = FlyoutPlacementMode.Bottom });
        else
            flyout.ShowAt(root, new FlyoutShowOptions
            {
                Position = anchor is { } rect ? new Point(rect.X, rect.Bottom + 4) : new Point(6, 44),
                Placement = FlyoutPlacementMode.BottomEdgeAlignedLeft,
            });
    }

    /// <summary>
    /// One row: a check for the current instance (null: no check column), the icon and the
    /// label as one button, and an optional trailing icon button.
    /// </summary>
    private static Grid MenuRow(
        Flyout flyout,
        string glyph,
        string label,
        bool? selected,
        Action activate,
        (string Glyph, string Tip, Action Action)? trailing
    )
    {
        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var inner = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        inner.Children.Add(new FontIcon { Glyph = "\uE73E", FontSize = 12, Width = 16, Opacity = selected == true ? 1 : 0 });
        inner.Children.Add(new FontIcon { Glyph = glyph, FontSize = 16 });
        inner.Children.Add(new TextBlock
        {
            Text = label,
            TextTrimming = TextTrimming.CharacterEllipsis,
            VerticalAlignment = VerticalAlignment.Center,
        });
        var main = new Button
        {
            Content = inner,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(8, 7, 8, 7),
        };
        AutomationProperties.SetName(main, selected == true ? label + ", current" : label);
        main.Click += (_, _) =>
        {
            flyout.Hide();
            activate();
        };
        row.Children.Add(main);
        if (trailing is { } action)
        {
            var button = new Button
            {
                Content = new FontIcon { Glyph = action.Glyph, FontSize = 14 },
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                BorderThickness = new Thickness(0),
                Padding = new Thickness(9),
                Margin = new Thickness(2, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center,
            };
            ToolTipService.SetToolTip(button, action.Tip);
            AutomationProperties.SetName(button, action.Tip);
            button.Click += (_, _) =>
            {
                flyout.Hide();
                action.Action();
            };
            Grid.SetColumn(button, 1);
            row.Children.Add(button);
        }
        return row;
    }

    private async Task AddRemoteAsync()
    {
        if (instances is null || Content.XamlRoot is null || dialogOpen || exiting)
            return;
        var input = new TextBox
        {
            Header = "Address",
            PlaceholderText = "https://example.com/foxwarm/",
            MinWidth = 360,
            IsSpellCheckEnabled = false,
            InputScope = new InputScope { Names = { new InputScopeName(InputScopeNameValue.Url) } },
        };
        var error = new TextBlock
        {
            Text = "Enter an http or https address.",
            TextWrapping = TextWrapping.Wrap,
            Visibility = Visibility.Collapsed,
            Foreground = new SolidColorBrush(Theme == ElementTheme.Dark
                ? Windows.UI.Color.FromArgb(0xff, 0xff, 0x99, 0xa4)
                : Windows.UI.Color.FromArgb(0xff, 0xc4, 0x2b, 0x1c)),
        };
        var body = new StackPanel { Spacing = 8 };
        body.Children.Add(input);
        body.Children.Add(error);
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            RequestedTheme = Theme,
            Title = "Add remote instance",
            Content = body,
            PrimaryButtonText = "Add",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
        };
        Uri? url = null;
        dialog.PrimaryButtonClick += (_, e) =>
        {
            url = DesktopInstances.Normalize(input.Text);
            if (url is not null)
                return;
            error.Visibility = Visibility.Visible;
            e.Cancel = true;
        };
        dialogOpen = true;
        ContentDialogResult result;
        try
        {
            result = await dialog.ShowAsync();
        }
        finally
        {
            dialogOpen = false;
        }
        if (result == ContentDialogResult.Primary && url is not null && !exiting)
            await SwitchAsync(instances.Add(url));
    }

    private async Task<bool> ConfirmStopAsync(int running)
    {
        if (Content.XamlRoot is null || dialogOpen)
            return false;
        var dialog = new ContentDialog
        {
            XamlRoot = Content.XamlRoot,
            RequestedTheme = Theme,
            Title = "Stop the local instance?",
            Content = new TextBlock { Text = DesktopInstances.RunningSessionsText(running), TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = "Stop",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close,
        };
        dialogOpen = true;
        try
        {
            return await dialog.ShowAsync() == ContentDialogResult.Primary;
        }
        finally
        {
            dialogOpen = false;
        }
    }
}
