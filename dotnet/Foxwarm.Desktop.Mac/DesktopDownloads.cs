using AppKit;
using Foundation;
using WebKit;

namespace Foxwarm.Desktop;

/// <summary>
/// Saves the app's downloads (D-desktop-downloads). WKWebView has no download behaviour of
/// its own: the navigation delegate turns the requests <see cref="DesktopDownloadPolicy"/>
/// allows into WKDownloads and hands them here. Each one asks where to save it with the native
/// save panel, a sheet on the window that started it, prefilled with the suggested name;
/// Cancel ends it. A finished download is announced to the Dock's Downloads stack, and one
/// that fails shows an alert.
/// </summary>
internal sealed class DesktopDownloads(Func<NSWindow?> mainWindow) : WKDownloadDelegate
{
    // WebKit holds a download's delegate weakly; the application keeps this object, and this
    // keeps each running download with what it was saved as.
    private readonly Dictionary<WKDownload, Download> running = [];
    // The panel opens in the folder of the previous download, at first in Downloads.
    private NSUrl? folder;
    private bool closed;

    private sealed class Download
    {
        internal string Name = DesktopDownloadPolicy.FallbackName;
        internal string? Path;
        internal NSWindow? Window;
        internal bool Cancelled;
    }

    /// <summary>Takes over a download the navigation delegate started.</summary>
    internal void Start(WKDownload download)
    {
        running[download] = new Download { Window = download.WebView?.Window };
        download.Delegate = this;
        if (closed)
            Cancel(download);
    }

    /// <summary>Cancels running downloads and accepts no new ones (Quit).</summary>
    internal void Close()
    {
        closed = true;
        foreach (var download in running.Keys.ToArray())
            Cancel(download);
    }

    private void Cancel(WKDownload download)
    {
        if (running.TryGetValue(download, out var state))
            state.Cancelled = true;
        download.Cancel(null);
    }

    public override void DecideDestination(
        WKDownload download,
        NSUrlResponse response,
        string suggestedFilename,
        Action<NSUrl> completionHandler
    )
    {
        if (!running.TryGetValue(download, out var state))
            running[download] = state = new Download { Window = download.WebView?.Window };
        if (closed || state.Cancelled)
        {
            state.Cancelled = true;
            completionHandler(null!);
            return;
        }
        state.Name = DesktopDownloadPolicy.FileName(suggestedFilename);
        var panel = NSSavePanel.SavePanel;
        panel.CanCreateDirectories = true;
        // A name that is taken in that folder is offered as a Finder-style copy name rather
        // than asking to replace the file.
        folder ??= DownloadsFolder();
        if (folder is not null)
            panel.DirectoryUrl = folder;
        var directory = folder?.Path;
        panel.NameFieldStringValue = directory is null
            ? state.Name
            : DesktopDownloadPolicy.UniqueName(directory, state.Name, path => File.Exists(path) || Directory.Exists(path));
        var window = state.Window is { IsVisible: true } ? state.Window : mainWindow();
        state.Window = window;
        if (window is { IsVisible: true })
            panel.BeginSheet(window, result => Chosen(panel, (long)result, state, completionHandler));
        else
            Chosen(panel, (long)panel.RunModal(), state, completionHandler);
    }

    private void Chosen(NSSavePanel panel, long result, Download state, Action<NSUrl> completionHandler)
    {
        try
        {
            var url = panel.Url;
            if (result != (long)NSModalResponse.OK || url?.Path is not { } path || closed || state.Cancelled)
            {
                state.Cancelled = true;
                completionHandler(null!);
                return;
            }
            // The panel has already asked whether to replace an existing file; WebKit only
            // writes a new one, so the old one goes to the Trash.
            if ((File.Exists(path) || Directory.Exists(path))
                && !NSFileManager.DefaultManager.TrashItem(url, out _, out var error))
            {
                state.Cancelled = true;
                completionHandler(null!);
                ShowFailure(state, error);
                return;
            }
            state.Path = path;
            folder = url.RemoveLastPathComponent();
            completionHandler(url);
        }
        finally
        {
            panel.Dispose();
        }
    }

    public override void DidFinish(WKDownload download)
    {
        if (!running.Remove(download, out var state) || state.Path is null)
            return;
        // Bounces the Downloads stack in the Dock when the file was saved in that folder.
        NSDistributedNotificationCenter.DefaultCenter.PostNotificationName(
            "com.apple.DownloadFileFinished",
            state.Path
        );
    }

    public override void DidFail(WKDownload download, NSError error, NSData? resumeData)
    {
        if (!running.Remove(download, out var state))
            return;
        var cancelled = error.Domain == NSError.NSUrlErrorDomain.ToString() && error.Code == (long)NSUrlError.Cancelled;
        if (state.Cancelled || closed || cancelled)
            return;
        ShowFailure(state, error);
    }

    private void ShowFailure(Download state, NSError? error)
    {
        var alert = new NSAlert
        {
            AlertStyle = NSAlertStyle.Warning,
            MessageText = "“" + state.Name + "” couldn’t be downloaded.",
            InformativeText = error?.LocalizedDescription ?? "",
        };
        alert.AddButton("OK");
        var window = state.Window is { IsVisible: true } ? state.Window : mainWindow();
        if (window is { IsVisible: true })
            alert.BeginSheet(window, _ => alert.Dispose());
        else
        {
            alert.RunModal();
            alert.Dispose();
        }
    }

    private static NSUrl? DownloadsFolder() =>
        NSFileManager.DefaultManager.GetUrls(NSSearchPathDirectory.DownloadsDirectory, NSSearchPathDomain.User)
            .FirstOrDefault();
}
