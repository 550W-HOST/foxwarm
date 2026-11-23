using System.Diagnostics;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;

namespace Foxwarm.Desktop;

/// <summary>
/// The web views of every Desktop window share one WebView2 environment and profile, so
/// cookies and storage carry over (each origin keeps its own), and one policy
/// (<see cref="DesktopNavigation"/>): the selected instance's scope stays in the app, a
/// new-window request in it opens an app window that keeps <c>window.opener</c>, and other
/// web pages go to the default browser.
/// </summary>
internal sealed class DesktopWebViews(CoreWebView2Environment environment, Uri scope)
{
    private readonly List<DesktopPopupWindow> popups = [];
    private bool closing;

    internal CoreWebView2Environment Environment => environment;

    /// <summary>The selected instance: its origin and base path. Switching closes the app windows first.</summary>
    internal Uri Scope { get; set; } = scope;

    /// <summary>Opens the host's instance menu for a framed window's brand row.</summary>
    internal Action<Window, FrameRect>? InstanceMenu { get; init; }

    internal bool IsAppUri(string? text) => DesktopNavigation.IsApp(Scope, text);

    /// <summary>
    /// Applies the policy to a web view before its first navigation. <paramref name="owner"/>
    /// is the window new windows cascade from; <paramref name="leftApp"/> runs when a
    /// top-level navigation was refused or sent to the default browser.
    /// </summary>
    internal void Configure(CoreWebView2 core, Window owner, Action? leftApp = null)
    {
        core.Settings.AreHostObjectsAllowed = false;
        core.NavigationStarting += (_, e) =>
        {
            var target = DesktopNavigation.Classify(Scope, e.Uri);
            if (target is DesktopTarget.App or DesktopTarget.Blank)
                return;
            e.Cancel = true;
            if (target == DesktopTarget.Browser)
                OpenExternal(e.Uri);
            leftApp?.Invoke();
        };
        core.NewWindowRequested += (_, e) => OpenWindow(e, owner);
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) =>
        {
            if (
                Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri)
                && uri.Scheme is "http" or "https"
                && !IsAppUri(e.Request.Uri)
            )
                e.Response = environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
        };
    }

    /// <summary>Closes every app window except the main one and refuses new ones (Exit, shutdown).</summary>
    internal void CloseAll()
    {
        closing = true;
        CloseWindows();
    }

    /// <summary>Closes every app window except the main one, e.g. before switching instances.</summary>
    internal void CloseWindows()
    {
        foreach (var popup in popups.ToArray())
            popup.Close();
        popups.Clear();
    }

    private async void OpenWindow(CoreWebView2NewWindowRequestedEventArgs e, Window owner)
    {
        var target = DesktopNavigation.Classify(Scope, e.Uri);
        if (closing || target is DesktopTarget.Browser or DesktopTarget.Ignore)
        {
            // Handled without a new window: window.open returns a window that never loads.
            e.Handled = true;
            if (!closing && target == DesktopTarget.Browser)
                OpenExternal(e.Uri);
            return;
        }
        var deferral = e.GetDeferral();
        DesktopPopupWindow? popup = null;
        try
        {
            var features = e.WindowFeatures;
            popup = new DesktopPopupWindow(
                this,
                owner,
                DesktopNavigation.FrameFor(Scope, e.Uri),
                target == DesktopTarget.Blank,
                features.HasSize ? features.Width : null,
                features.HasSize ? features.Height : null
            );
            var opened = popup;
            popups.Add(opened);
            opened.Closed += (_, _) => popups.Remove(opened);
            // Scripts, filters and handlers are in place before the opener's document is attached.
            e.NewWindow = await opened.InitializeAsync();
            e.Handled = true;
        }
        catch (Exception error)
        {
            Debug.WriteLine(error);
            e.Handled = true;
            popup?.Close();
        }
        finally
        {
            deferral.Complete();
        }
    }

    internal static void OpenExternal(string text)
    {
        if (
            !Uri.TryCreate(text, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
        )
            return;
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception error)
            when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            DesktopNative.ShowMessage("The link could not be opened in your browser.");
        }
    }
}
