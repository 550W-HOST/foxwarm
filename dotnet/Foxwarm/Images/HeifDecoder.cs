using System.Runtime.InteropServices;

namespace Foxwarm.Images;

internal sealed class ImageInputException(string message, Exception? inner = null) : IOException(message, inner);

// Optional, lazy Linux prerequisite. Raster images never load this decoder.
internal static class HeifDecoder
{
    internal const long MaxPixels = 64L * 1024 * 1024;
    internal sealed record Pixels(byte[] Rgba, int Width, int Height, bool HasTransparency);
    [StructLayout(LayoutKind.Sequential)] private struct Error { internal int Code; internal int Subcode; internal IntPtr Message; }
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr Pointer();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint Version();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void Release(IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr Limits(IntPtr context);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int Decoder(int format);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate Error Read(IntPtr context, IntPtr data, nuint length, IntPtr options);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate Error Primary(IntPtr context, out IntPtr handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int Dimension(IntPtr handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int ImageDimension(IntPtr image, int channel);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate Error Decode(IntPtr handle, out IntPtr image, int colorspace, int chroma, IntPtr options);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr Plane(IntPtr image, int channel, out nuint stride);
    private sealed class Api
    {
        // Handles deliberately remain loaded for the lifetime of the process.
        private readonly IntPtr heif;
        private readonly IntPtr de265;
        internal readonly Pointer Allocate, AllocateOptions;
        internal readonly Release Free, ReleaseHandle, ReleaseImage, FreeOptions;
        internal readonly Limits SecurityLimits;
        internal readonly Read ReadMemory;
        internal readonly Primary GetPrimary;
        internal readonly Dimension Width, Height;
        internal readonly ImageDimension ImageWidth, ImageHeight;
        internal readonly Decode DecodePixels;
        internal readonly Plane GetPlane;
        internal Api()
        {
            if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
                throw new ImageInputException("HEIC input requires the documented Linux x64 native decoder prerequisite.");
            try
            {
                de265 = NativeLibrary.Load("libde265.so.0");
                heif = NativeLibrary.Load("libheif.so.1");
                if (Load<Version>(heif, "heif_get_version_number")() != 0x01170500
                    || Marshal.PtrToStringUTF8(Load<Pointer>(de265, "de265_get_version")()) != "1.1.3")
                    throw new ImageInputException("HEIC input requires libheif 1.23.5 with libde265 1.1.3.");
                if (Load<Decoder>(heif, "heif_have_decoder_for_format")(1) == 0)
                    throw new ImageInputException("The HEIC native prerequisite has no HEVC decoder.");
                Allocate = Load<Pointer>(heif, "heif_context_alloc"); Free = Load<Release>(heif, "heif_context_free");
                SecurityLimits = Load<Limits>(heif, "heif_context_get_security_limits");
                ReadMemory = Load<Read>(heif, "heif_context_read_from_memory_without_copy");
                GetPrimary = Load<Primary>(heif, "heif_context_get_primary_image_handle");
                Width = Load<Dimension>(heif, "heif_image_handle_get_width"); Height = Load<Dimension>(heif, "heif_image_handle_get_height");
                ImageWidth = Load<ImageDimension>(heif, "heif_image_get_width"); ImageHeight = Load<ImageDimension>(heif, "heif_image_get_height");
                DecodePixels = Load<Decode>(heif, "heif_decode_image"); GetPlane = Load<Plane>(heif, "heif_image_get_plane_readonly2");
                ReleaseHandle = Load<Release>(heif, "heif_image_handle_release"); ReleaseImage = Load<Release>(heif, "heif_image_release");
                AllocateOptions = Load<Pointer>(heif, "heif_decoding_options_alloc"); FreeOptions = Load<Release>(heif, "heif_decoding_options_free");
            }
            catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
            { throw new ImageInputException("HEIC input requires compatible libheif 1.23.5 and libde265 1.1.3 native libraries.", error); }
        }
        private static T Load<T>(IntPtr library, string symbol) where T : Delegate =>
            Marshal.GetDelegateForFunctionPointer<T>(NativeLibrary.GetExport(library, symbol));
    }
    private static readonly Lazy<Api> Native = new(() => new Api());

    internal static void RequirePrerequisite() => _ = Native.Value;

    internal static Pixels DecodeImage(byte[] bytes, long pixelLimit = MaxPixels)
    {
        if (pixelLimit <= 0 || pixelLimit > MaxPixels) throw new ArgumentOutOfRangeException(nameof(pixelLimit));
        var api = Native.Value;
        var context = api.Allocate();
        if (context == IntPtr.Zero) throw new ImageInputException("HEIC decoder could not allocate its context.");
        var handle = IntPtr.Zero; var image = IntPtr.Zero; var options = IntPtr.Zero; var decoderId = IntPtr.Zero; GCHandle pinned = default;
        try
        {
            var limits = api.SecurityLimits(context);
            if (limits == IntPtr.Zero || Marshal.ReadByte(limits) != 4)
                throw new ImageInputException("HEIC native security-limit ABI is incompatible.");
            // v1.23.5 C ABI: uint8 version, padding, uint64 max_image_size_pixels.
            // Preserve every other native default; never request disabled limits.
            Marshal.WriteInt64(limits, 8, pixelLimit);
            pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            Check(api.ReadMemory(context, pinned.AddrOfPinnedObject(), (nuint)bytes.Length, IntPtr.Zero), "HEIC container is invalid or exceeds native safety limits.");
            Check(api.GetPrimary(context, out handle), "HEIC input has no valid primary image.");
            var width = api.Width(handle); var height = api.Height(handle);
            if (width <= 0 || height <= 0 || (long)width * height > pixelLimit)
                throw new ImageInputException("Image exceeds the 64-megapixel limit or has invalid dimensions.");
            // RGB=1, interleaved RGBA=11, default geometric transformations enabled.
            options = api.AllocateOptions();
            if (options == IntPtr.Zero || Marshal.ReadByte(options) < 4) throw new ImageInputException("HEIC native decoding-options ABI is incompatible.");
            decoderId = Marshal.StringToCoTaskMemUTF8("libde265");
            Marshal.WriteIntPtr(options, 48, decoderId); // v1.23.5 x64 decoder_id
            Check(api.DecodePixels(handle, out image, 1, 11, options), "HEIC pixels are invalid or exceed native safety limits.");
            var decodedWidth = api.ImageWidth(image, 10); var decodedHeight = api.ImageHeight(image, 10);
            if (decodedWidth != width || decodedHeight != height || decodedWidth <= 0 || decodedHeight <= 0 || (long)decodedWidth * decodedHeight > pixelLimit)
                throw new ImageInputException("HEIC decoder returned incompatible transformed plane dimensions.");
            var plane = api.GetPlane(image, 10, out var stride); // interleaved=10
            var rowBytes = checked(width * 4);
            if (plane == IntPtr.Zero || stride < (nuint)rowBytes || stride > int.MaxValue
                || stride * (nuint)height > int.MaxValue)
                throw new ImageInputException("HEIC decoder returned an invalid pixel plane.");
            var rgba = new byte[checked(rowBytes * height)];
            for (var row = 0; row < height; row++) Marshal.Copy(IntPtr.Add(plane, checked(row * (int)stride)), rgba, row * rowBytes, rowBytes);
            var alpha = false;
            for (var index = 3; index < rgba.Length; index += 4) if (rgba[index] != 255) { alpha = true; break; }
            return new(rgba, width, height, alpha);
        }
        finally
        {
            if (options != IntPtr.Zero) api.FreeOptions(options);
            if (decoderId != IntPtr.Zero) Marshal.FreeCoTaskMem(decoderId);
            if (image != IntPtr.Zero) api.ReleaseImage(image);
            if (handle != IntPtr.Zero) api.ReleaseHandle(handle);
            api.Free(context);
            if (pinned.IsAllocated) pinned.Free();
        }
    }
    private static void Check(Error error, string reason)
    { if (error.Code != 0) throw new ImageInputException(reason); }
}
