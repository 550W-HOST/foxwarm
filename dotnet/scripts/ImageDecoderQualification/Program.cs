using System.Runtime.InteropServices;
using Foxwarm.ImageDecoder;
using Foxwarm.Images;
using static Foxwarm.Images.DecoderProtocol;

// Separate executable, never included in an application payload. As a fixture it consumes
// one harmless scenario number in place of image bytes and uses the real confinement policy.
if (args is ["raster"])
    return FaultChild.Run();
if (args.Length is < 1 or > 2)
    return 2;
var log = new List<string>();
var worker = new ImageDecoderProcess(Path.GetFullPath(args[0]), log.Add);
var fault = new ImageDecoderProcess(Environment.ProcessPath!, log.Add);
byte[] gif = Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
async Task CheckParentAndWorker()
{
    var p = await worker.RunAsync(DecodeOperation.Probe, gif, "image/gif", true);
    if (p is not { Width: 1, Height: 1, Mime: "image/gif" })
        throw new Exception("bad probe");
}
await CheckParentAndWorker();
(string Name, string Diagnostic)[] cases =
[
    ("SIGSEGV", "SIGSEGV"),
    ("forbidden file open", "SIGSYS"),
    ("forbidden socket", "SIGSYS"),
    ("address-space ceiling", "resource limit"),
    ("CPU spin", "SIGKILL"),
    ("oversized reply", "malformed"),
    ("truncated reply", "malformed"),
    ("unexpected output", "malformed"),
];
for (byte i = 0; i < cases.Length; i++)
{
    log.Clear();
    try
    {
        await fault.RunAsync(DecodeOperation.Probe, [i], "image/gif");
        throw new Exception("fault unexpectedly succeeded");
    }
    catch (ImageProcessingException e) when (e.Message == Failed) { }
    if (log.Count != 1 || !log[0].Contains(cases[i].Diagnostic, StringComparison.Ordinal))
        throw new Exception(
            $"{cases[i].Name}: expected {cases[i].Diagnostic}, got: {string.Join(';', log)}"
        );
    await CheckParentAndWorker();
    Console.WriteLine("contained: " + cases[i].Name);
}
var variant = await worker.RunAsync(DecodeOperation.Optimize, gif, "image/gif");
var crop = await worker.RunAsync(
    DecodeOperation.Crop,
    variant.Bytes,
    variant.Mime,
    width: 1,
    height: 1
);
if (crop is not { Width: 1, Height: 1, Mime: "image/webp" })
    throw new Exception("crop failed");
try
{
    await worker.RunAsync(DecodeOperation.Probe, [0], "image/gif");
    throw new Exception("bad raster accepted");
}
catch (ImageInputException e) when (e.InvalidRaster && e.Message == "Image raster is invalid.") { }
try
{
    await worker.RunAsync(DecodeOperation.Crop, gif, "image/gif", width: 2, height: 1);
    throw new Exception("bad crop accepted");
}
catch (InvalidDataException e)
    when (e.Message == "Crop rectangle (0, 0, 2, 1) exceeds source image bounds 1x1.") { }
if (args.Length == 2)
{
    var bytes = await File.ReadAllBytesAsync(args[1]);
    var heif = await worker.RunAsync(DecodeOperation.Optimize, bytes, "image/heic", true);
    if (heif is not { Width: 3, Height: 2, Mime: "image/jpeg" })
        throw new Exception("HEIF conversion failed");
}
Console.WriteLine("isolated worker protocol and parent recovery passed");
return 0;

internal static partial class FaultChild
{
    [LibraryImport("libc")]
    private static partial int getpid();

    [LibraryImport("libc")]
    private static partial int gettid();

    [LibraryImport("libc")]
    private static partial int tgkill(int pid, int tid, int signal);

    [LibraryImport("libc")]
    private static partial nint signal(int signal, nint handler);

    [LibraryImport("libc", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int open(string path, int flags);

    [LibraryImport("libc")]
    private static partial int socket(int domain, int type, int protocol);

    [LibraryImport("libc", SetLastError = true)]
    private static partial nint mmap(
        nint addr,
        nuint length,
        int prot,
        int flags,
        int fd,
        nint offset
    );

    [LibraryImport("libc", EntryPoint = "_exit")]
    private static partial void Exit(int code);

    internal static int Run()
    {
        signal(11, 0); // deterministic synthetic native crash, without the runtime's signal handler
        if (!Sandbox.Enter())
            return 3;
        Pipes.Transfer(new byte[RequestSize], true);
        byte[] scenario = new byte[1];
        Pipes.Transfer(scenario, true);
        switch (scenario[0])
        {
            case 0:
                tgkill(getpid(), gettid(), 11);
                break;
            case 1:
                open("/dev/null", 0);
                break;
            case 2:
                socket(2, 1, 0);
                break;
            case 3:
                // Prove that a private 1 GiB mapping is refused by the kernel, without committing
                // pages or applying memory pressure to the parent/CI runner.
                if (mmap(0, 1U << 30, 3, 0x22, -1, 0) == -1 && Marshal.GetLastPInvokeError() == 12)
                    Exit(4);
                break;
            case 4:
                while (true)
                    Thread.SpinWait(1000);
            case 5:
                Pipes.Transfer(Header(Ok, 3, 1, 1, 1, int.MaxValue), false);
                Exit(0);
                break;
            case 6:
                Pipes.Transfer([1, 2], false);
                Exit(0);
                break;
            case 7:
                Pipes.Transfer(Header(Ok, 3, 1, 1, 1, 0), false);
                Pipes.Transfer([0], false);
                Exit(0);
                break;
        }
        Exit(5);
        return 5;
    }
}
