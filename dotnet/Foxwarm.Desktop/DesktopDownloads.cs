using System.Diagnostics;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;
using Windows.Foundation;

namespace Foxwarm.Desktop;

/// <summary>
/// Saves the app's downloads (D-desktop-downloads). Every WebView2 download that
/// <see cref="DesktopDownloadPolicy"/> allows asks where to save it with the Save As dialog,
/// owned by the window that started it, before WebView2 chooses a file; Cancel cancels it,
/// and other downloads are cancelled. WebView2's downloads flyout stays: it shows progress
/// and opens the saved file. A download that fails also shows a message.
/// </summary>
internal sealed class DesktopDownloads
{
    // One dialog at a time: a page that starts several downloads gets one dialog after another.
    private readonly Queue<Request> waiting = [];
    private bool asking;
    private bool closed;

    private sealed record Request(
        Window Owner,
        CoreWebView2DownloadStartingEventArgs Args,
        Deferral Deferral,
        string Name
    );

    /// <summary>
    /// Handles the downloads of a web view hosted in <paramref name="owner"/>;
    /// <paramref name="scope"/> is the selected instance's current scope.
    /// </summary>
    internal void Attach(CoreWebView2 core, Window owner, Func<Uri> scope)
    {
        core.DownloadStarting += (_, e) =>
        {
            if (closed || !DesktopDownloadPolicy.Allows(scope(), e.DownloadOperation.Uri, core.Source))
            {
                e.Cancel = true;
                return;
            }
            // WebView2's file name is already valid on Windows; it is made safe the same way as on macOS.
            var name = DesktopDownloadPolicy.FileName(Path.GetFileName(e.ResultFilePath));
            waiting.Enqueue(new Request(owner, e, e.GetDeferral(), name));
            // The dialog runs its own message loop, so it never runs inside a WebView2 event.
            if (!asking)
                owner.DispatcherQueue.TryEnqueue(AskNext);
        };
    }

    /// <summary>
    /// Makes <paramref name="folder"/> the profile's default download folder. WebView2 receives a
    /// download while the dialog is open, into a temporary file in that folder, and numbers the
    /// suggested name ("name (1).ext") when the folder already has it. A folder of the host's own
    /// keeps both out of the user's Downloads; files an earlier run left there are removed.
    /// </summary>
    internal static void UseFolder(CoreWebView2Profile profile, string folder)
    {
        try
        {
            Directory.CreateDirectory(folder);
            foreach (var file in Directory.EnumerateFiles(folder))
                File.Delete(file);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Debug.WriteLine(error);
        }
        profile.DefaultDownloadFolderPath = folder;
    }

    /// <summary>Cancels downloads that have not been given a file yet and accepts no new ones (Exit).</summary>
    internal void Close()
    {
        closed = true;
        AskNext();
    }

    private void AskNext()
    {
        while (!asking && waiting.TryDequeue(out var request))
        {
            asking = true;
            try
            {
                Ask(request);
            }
            finally
            {
                asking = false;
            }
        }
    }

    private void Ask(Request request)
    {
        var (owner, e, deferral, name) = request;
        try
        {
            var path = closed
                ? null
                : DesktopSaveDialog.Ask(WinRT.Interop.WindowNative.GetWindowHandle(owner), name);
            if (path is null || closed)
            {
                e.Cancel = true;
                return;
            }
            // The dialog has asked before replacing an existing file; WebView2 then overwrites it.
            e.ResultFilePath = path;
            var download = e.DownloadOperation;
            download.StateChanged += (_, _) => StateChanged(owner, download, Path.GetFileName(path));
        }
        catch (Exception error)
        {
            // The window and its web view may be gone; nothing is saved then.
            Debug.WriteLine(error);
            Cancel(e);
        }
        finally
        {
            Complete(deferral);
        }
    }

    private static void Cancel(CoreWebView2DownloadStartingEventArgs e)
    {
        try
        {
            e.Cancel = true;
        }
        catch (Exception error)
        {
            Debug.WriteLine(error);
        }
    }

    private static void Complete(Deferral deferral)
    {
        try
        {
            deferral.Complete();
        }
        catch (Exception error)
        {
            Debug.WriteLine(error);
        }
    }

    private void StateChanged(Window owner, CoreWebView2DownloadOperation download, string name)
    {
        if (closed || download.State != CoreWebView2DownloadState.Interrupted)
            return;
        Failed(owner, download.InterruptReason, name);
    }

    private void Failed(Window owner, CoreWebView2DownloadInterruptReason reason, string name)
    {
        if (reason is CoreWebView2DownloadInterruptReason.UserCanceled or CoreWebView2DownloadInterruptReason.UserShutdown)
            return;
        // Not inside the web view's event either.
        owner.DispatcherQueue.TryEnqueue(() =>
        {
            if (!closed)
                DesktopNative.ShowWarning(
                    WinRT.Interop.WindowNative.GetWindowHandle(owner),
                    "“" + name + "” couldn’t be downloaded. " + Describe(reason)
                );
        });
    }

    private static string Describe(CoreWebView2DownloadInterruptReason reason) =>
        reason switch
        {
            CoreWebView2DownloadInterruptReason.FileNoSpace => "There isn’t enough disk space.",
            CoreWebView2DownloadInterruptReason.FileAccessDenied => "The file couldn’t be written there.",
            CoreWebView2DownloadInterruptReason.FileNameTooLong => "The file name is too long.",
            CoreWebView2DownloadInterruptReason.FileTooLarge => "The file is too large for this drive.",
            CoreWebView2DownloadInterruptReason.FileMalicious
            or CoreWebView2DownloadInterruptReason.FileBlockedByPolicy
            or CoreWebView2DownloadInterruptReason.FileSecurityCheckFailed => "Windows blocked the file.",
            CoreWebView2DownloadInterruptReason.NetworkFailed
            or CoreWebView2DownloadInterruptReason.NetworkTimeout
            or CoreWebView2DownloadInterruptReason.NetworkDisconnected
            or CoreWebView2DownloadInterruptReason.NetworkServerDown
            or CoreWebView2DownloadInterruptReason.NetworkInvalidRequest => "The connection was interrupted.",
            CoreWebView2DownloadInterruptReason.ServerFailed
            or CoreWebView2DownloadInterruptReason.ServerNoRange
            or CoreWebView2DownloadInterruptReason.ServerBadContent
            or CoreWebView2DownloadInterruptReason.ServerUnauthorized
            or CoreWebView2DownloadInterruptReason.ServerCertificateProblem
            or CoreWebView2DownloadInterruptReason.ServerForbidden
            or CoreWebView2DownloadInterruptReason.ServerUnexpectedResponse
            or CoreWebView2DownloadInterruptReason.ServerContentLengthMismatch
            or CoreWebView2DownloadInterruptReason.ServerCrossOriginRedirect => "The server couldn’t send the file.",
            _ => "The file couldn’t be saved.",
        };
}
