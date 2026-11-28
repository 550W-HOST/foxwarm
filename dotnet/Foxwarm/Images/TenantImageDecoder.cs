namespace Foxwarm.Images;

// All image stores of a hosted tenant, including independent Session authority stores, carry
// its immutable database ID. The worker receives neither that ID nor any store or scratch path.
internal sealed class TenantImageDecoder(int? tenant, ImageDecoderProcess worker)
{
    private static readonly DecoderAdmission Admission = new();
    private static readonly ImageDecoderProcess Worker = new(
        Path.Combine(AppContext.BaseDirectory, "Foxwarm.ImageDecoder"),
        line => MainLog.Diagnostic(line, failure: true)
    );
    internal static TenantImageDecoder Local { get; } = new(null, Worker);

    internal static TenantImageDecoder ForTenant(int id) => new(id, Worker);

    internal static TenantImageDecoder ForStorage(Foxwarm.Storage.IStorageContext storage)
    {
#if FOXWARM_HOSTED
        if (storage is Foxwarm.Hosted.PostgresStorageContext hosted)
            return ForTenant(hosted.Database.TenantId);
#endif
        return Local;
    }

    private async Task<ImageDecoderProcess.Result> Run(
        DecodeOperation op,
        byte[] bytes,
        string mime,
        CancellationToken token,
        bool flag = false,
        int x = 0,
        int y = 0,
        int width = 0,
        int height = 0
    )
    {
        using var slot = await Admission.EnterAsync(tenant!.Value, token);
        return await worker.RunAsync(op, bytes, mime, flag, x, y, width, height, token);
    }

    internal async Task<RasterCodec.Probe> InspectAsync(
        byte[] bytes,
        string mime,
        bool limit,
        CancellationToken token
    )
    {
        if (tenant is null)
        {
            if (!RasterCodec.IsHeif(mime))
                return RasterCodec.Inspect(bytes, mime, limit);
            var (w, h) = HeifDecoder.Inspect(bytes);
            if (limit)
                RasterCodec.ValidatePixels(w, h);
            return new(w, h, mime, default);
        }
        var r = await Run(DecodeOperation.Probe, bytes, mime, token, limit);
        return new(r.Width, r.Height, r.Mime, r.Origin);
    }

    internal async Task RequireHeifAsync(CancellationToken token)
    {
        if (tenant is not null)
            await Run(DecodeOperation.RequireHeif, [], "image/heif", token);
        else
            HeifDecoder.RequirePrerequisite();
    }

    internal async Task ValidateHeifAsync(byte[] bytes, CancellationToken token)
    {
        if (tenant is not null)
            await Run(DecodeOperation.ValidateHeif, bytes, "image/heif", token);
        else
            _ = HeifDecoder.DecodeImage(bytes);
    }

    internal async Task<RasterCodec.Variant> OptimizeAsync(byte[] bytes, string mime, string format)
    {
        if (tenant is null)
            return RasterCodec.Optimize(bytes, mime, format);
        if (format is not ("webp" or "jpeg"))
            throw new ImageInputException("Invalid provider image output format.");
        var r = await Run(
            DecodeOperation.Optimize,
            bytes,
            mime,
            CancellationToken.None,
            format == "jpeg"
        );
        return new(r.Bytes, r.Mime, r.Width, r.Height);
    }

    internal async Task<RasterCodec.Variant> CropAsync(
        byte[] bytes,
        string mime,
        int x,
        int y,
        int width,
        int height,
        CancellationToken token
    )
    {
        if (!RasterCodec.IsHeif(mime) && !RasterCodec.IsSafeRaster(mime))
            throw new InvalidDataException(
                "image_crop supports PNG, JPEG, WebP, and HEIF images on this host."
            );
        if (tenant is null)
        {
            try
            {
                return RasterCrop.Crop(bytes, mime, x, y, width, height);
            }
            catch (RasterCrop.Outside bounds)
            {
                throw bounds.ForRectangle(x, y, width, height);
            }
        }
        var r = await Run(
            DecodeOperation.Crop,
            bytes,
            mime,
            token,
            x: x,
            y: y,
            width: width,
            height: height
        );
        return new(r.Bytes, r.Mime, r.Width, r.Height);
    }

    internal async Task<string?> IdentifyFileAsync(string path, CancellationToken token)
    {
        if (tenant is null)
            return RasterCodec.IdentifyFile(path);
        try
        {
            // QQ already checks its 20 MiB media limit. Bound the opened file too if the source
            // is replaced or grows between that check and probing. No path goes to the codec.
            await using var file = File.OpenRead(path);
            long length = file.Length;
            if (length > DecoderProtocol.MaxBytes)
                return null;
            // Wait before buffering the spool, so a backlog of QQ probes cannot retain a
            // separate media-sized array for every waiting request.
            using var slot = await Admission.EnterAsync(tenant.Value, token);
            var bytes = new byte[(int)length];
            await file.ReadExactlyAsync(bytes, token);
            var r = await worker.RunAsync(DecodeOperation.Identify, bytes, "", token: token);
            return r.Mime.Length == 0 ? null : r.Mime;
        }
        catch (Exception error)
            when (error is not ImageProcessingException
                && error is IOException or UnauthorizedAccessException
            )
        {
            return null;
        }
    }
}
