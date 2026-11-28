using Foxwarm.ImageDecoder;
using Foxwarm.Images;
using SkiaSharp;
using static Foxwarm.Images.DecoderProtocol;

// Normal runtime shutdown can open files or notify diagnostic facilities. Leave directly after
// success *or* refusal, so the parent gets the actual exit status under the installed filter.
NativeExit.Done(Serve(args));

static int Serve(string[] args)
{
    // Only the trusted operation class is known before confinement. The media and request frame
    // are never consulted until every thread is restricted. A fresh process handles exactly one.
    if (args is not (["raster"] or ["heif"]))
        return 2;
    try
    {
        using (SKData.CreateCopy(new byte[] { 0 })) { } // load the shipped Skia library before open is denied
        ImageInputException? prerequisite = null;
        if (args[0] == "heif")
            try
            {
                HeifDecoder.RequirePrerequisite();
            }
            catch (ImageInputException e)
            {
                prerequisite = e;
            }
        if (!Sandbox.Enter())
            return 3;
        var header = new byte[RequestSize];
        Pipes.Transfer(header, true);
        var op = (DecodeOperation)Read(header, 0);
        int m = Read(header, 1),
            n = Read(header, 2),
            flag = Read(header, 3);
        if ((uint)m >= Mimes.Length || (uint)n > MaxBytes || (uint)flag > 1)
            return 2;
        var mime = Mimes[m];
        if (RasterCodec.IsHeif(mime) != (args[0] == "heif"))
            return 2;
        var bytes = new byte[n];
        Pipes.Transfer(bytes, true);
        try
        {
            if (prerequisite is not null)
                throw prerequisite;
            int width = 0,
                height = 0,
                origin = 0,
                length = 0;
            byte[]? result = null;
            switch (op)
            {
                case DecodeOperation.Probe when RasterCodec.IsHeif(mime):
                    (width, height) = HeifDecoder.Inspect(bytes);
                    if (flag == 1)
                        RasterCodec.ValidatePixels(width, height);
                    break;
                case DecodeOperation.Probe:
                    var probe = RasterCodec.Inspect(bytes, mime, flag == 1);
                    (width, height, origin) = (probe.Width, probe.Height, (int)probe.Origin);
                    break;
                case DecodeOperation.Identify:
                    using (var data = SKData.CreateCopy(bytes))
                    using (var codec = SKCodec.Create(data))
                    {
                        m = Array.IndexOf(Mimes, RasterCodec.Identify(codec) ?? "");
                    }
                    break;
                case DecodeOperation.RequireHeif when RasterCodec.IsHeif(mime):
                    break;
                case DecodeOperation.ValidateHeif when RasterCodec.IsHeif(mime):
                    _ = HeifDecoder.DecodeImage(bytes);
                    break;
                case DecodeOperation.Optimize:
                case DecodeOperation.Crop:
                    var variant =
                        op == DecodeOperation.Optimize
                            ? RasterCodec.Optimize(bytes, mime, flag == 1 ? "jpeg" : "webp")
                            : RasterCrop.Crop(
                                bytes,
                                mime,
                                Read(header, 4),
                                Read(header, 5),
                                Read(header, 6),
                                Read(header, 7)
                            );
                    m = Array.IndexOf(Mimes, variant.MimeType);
                    width = variant.Width!.Value;
                    height = variant.Height!.Value;
                    if (ReferenceEquals(variant.Bytes, bytes))
                        length = -1;
                    else
                    {
                        result = variant.Bytes;
                        length = result.Length;
                    }
                    if (length > MaxBytes)
                        return 4;
                    break;
                default:
                    return 2;
            }
            Pipes.Transfer(Header(Ok, m, width, height, origin, length), false);
            if (result is not null)
                Pipes.Transfer(result, false);
        }
        catch (RasterCrop.Outside bounds)
        {
            Pipes.Transfer(Header(Bounds, 0, bounds.Width, bounds.Height, 0, 0), false);
        }
        catch (Exception e) when (e is ImageInputException or InvalidDataException)
        {
            int error = Array.IndexOf(Errors, e.Message);
            Pipes.Transfer(Header(error < 0 ? Refused : FirstError + error, 0, 0, 0, 0, 0), false);
        }
        return 0;
    }
    catch
    {
        return 4;
    }
}

internal static partial class NativeExit
{
    [System.Runtime.InteropServices.LibraryImport("libc", EntryPoint = "_exit")]
    internal static partial void Done(int status);
}
