using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;

namespace Foxwarm.Desktop;

/// <summary>
/// The Windows Save As dialog (the shell's common item dialog) for a download
/// (D-desktop-downloads): owned by a window, opened in the user's Downloads folder, prefilled
/// with a name, with a file type that keeps the name's extension. The dialog asks before
/// replacing an existing file.
/// </summary>
internal static partial class DesktopSaveDialog
{
    private static readonly Guid FileSaveDialog = new("C0B4E2F3-BA21-4773-8DBA-335EC946EB8B");
    private static readonly Guid FileDialogId = typeof(IFileDialog).GUID;
    private static readonly Guid ShellItemId = typeof(IShellItem).GUID;
    private static readonly Guid DownloadsFolder = new("374DE290-123F-4565-9164-39C4925E467B");

    private const int Cancelled = unchecked((int)0x800704C7); // HRESULT_FROM_WIN32(ERROR_CANCELLED)
    private const uint OverwritePrompt = 0x2;
    private const uint NoChangeDirectory = 0x8;
    private const uint ForceFileSystem = 0x40;
    private const uint PathMustExist = 0x800;
    private const uint NoReadOnlyReturn = 0x8000;
    private const uint FileSystemPath = 0x80058000; // SIGDN_FILESYSPATH

    /// <summary>The path the user chose, or null when they cancelled.</summary>
    internal static string? Ask(nint owner, string name)
    {
        Marshal.ThrowExceptionForHR(CoCreateInstance(FileSaveDialog, 0, 1, FileDialogId, out var dialog));
        dialog.SetOptions(
            dialog.GetOptions() | OverwritePrompt | NoChangeDirectory | ForceFileSystem | PathMustExist | NoReadOnlyReturn
        );
        // Every download starts in Downloads, not in the folder the dialog last used.
        if (SHGetKnownFolderItem(DownloadsFolder, 0, 0, ShellItemId, out var downloads) == 0)
            dialog.SetFolder(downloads);
        var extension = Path.GetExtension(name);
        var types = new List<(string Name, string Pattern)>();
        if (extension.Length > 1)
            types.Add((TypeName(extension) + " (*" + extension + ")", "*" + extension));
        types.Add(("All files (*.*)", "*.*"));
        var strings = new List<nint>();
        var specs = new FilterSpec[types.Count];
        try
        {
            for (var index = 0; index < types.Count; index++)
            {
                specs[index].Name = Marshal.StringToCoTaskMemUni(types[index].Name);
                specs[index].Pattern = Marshal.StringToCoTaskMemUni(types[index].Pattern);
                strings.Add(specs[index].Name);
                strings.Add(specs[index].Pattern);
            }
            unsafe
            {
                fixed (FilterSpec* pointer = specs)
                    dialog.SetFileTypes((uint)specs.Length, (nint)pointer);
            }
            dialog.SetFileTypeIndex(1);
            // A name typed without an extension gets the original one.
            if (extension.Length > 1)
                dialog.SetDefaultExtension(extension[1..]);
            dialog.SetFileName(name);
            var result = dialog.Show(owner);
            if (result == Cancelled)
                return null;
            Marshal.ThrowExceptionForHR(result);
            var path = dialog.GetResult().GetDisplayName(FileSystemPath);
            try
            {
                return Marshal.PtrToStringUni(path);
            }
            finally
            {
                Marshal.FreeCoTaskMem(path);
            }
        }
        finally
        {
            foreach (var text in strings)
                Marshal.FreeCoTaskMem(text);
        }
    }

    // The shell's name for the file type, e.g. "PNG File", as Explorer shows it.
    private static unsafe string TypeName(string extension)
    {
        var info = default(FileInfo);
        if (
            SHGetFileInfo(extension, 0x80, ref info, (uint)sizeof(FileInfo), 0x400 | 0x10) != 0 // FILE_ATTRIBUTE_NORMAL; SHGFI_TYPENAME | SHGFI_USEFILEATTRIBUTES
            && new string(info.TypeName) is { Length: > 0 } type
        )
            return type;
        return extension[1..].ToUpperInvariant() + " File";
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FilterSpec
    {
        public nint Name;
        public nint Pattern;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private unsafe struct FileInfo
    {
        public nint Icon;
        public int IconIndex;
        public uint Attributes;
        public fixed char DisplayName[260];
        public fixed char TypeName[80];
    }

    [LibraryImport("ole32.dll")]
    private static partial int CoCreateInstance(in Guid clsid, nint outer, uint context, in Guid iid, out IFileDialog dialog);

    [LibraryImport("shell32.dll")]
    private static partial int SHGetKnownFolderItem(in Guid folder, uint flags, nint token, in Guid iid, out IShellItem item);

    [LibraryImport("shell32.dll", EntryPoint = "SHGetFileInfoW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint SHGetFileInfo(string path, uint attributes, ref FileInfo info, uint size, uint flags);

    // IModalWindow and IFileDialog in vtable order; only the methods used here have exact types.
    [GeneratedComInterface(StringMarshalling = StringMarshalling.Utf16)]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    internal partial interface IFileDialog
    {
        [PreserveSig]
        int Show(nint owner);
        void SetFileTypes(uint count, nint types);
        void SetFileTypeIndex(uint index);
        uint GetFileTypeIndex();
        uint Advise(nint events);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        uint GetOptions();
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        IShellItem GetFolder();
        IShellItem GetCurrentSelection();
        void SetFileName(string name);
        nint GetFileName();
        void SetTitle(string title);
        void SetOkButtonLabel(string text);
        void SetFileNameLabel(string label);
        IShellItem GetResult();
        void AddPlace(IShellItem item, int place);
        void SetDefaultExtension(string extension);
        void Close(int result);
        void SetClientGuid(in Guid guid);
        void ClearClientData();
        void SetFilter(nint filter);
    }

    [GeneratedComInterface]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    internal partial interface IShellItem
    {
        nint BindToHandler(nint context, in Guid handler, in Guid iid);
        IShellItem GetParent();
        nint GetDisplayName(uint kind);
        uint GetAttributes(uint mask);
        [PreserveSig]
        int Compare(IShellItem other, uint hint, out int order);
    }
}
