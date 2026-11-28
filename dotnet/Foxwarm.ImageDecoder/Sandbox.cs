using System.Runtime.InteropServices;

namespace Foxwarm.ImageDecoder;

internal static partial class Sandbox
{
    // libseccomp resolves names for the current architecture and rejects alternate syscall ABIs.
    private const string Library = "libseccomp.so.2";

    [LibraryImport(Library)]
    private static partial nint seccomp_init(uint action);

    [LibraryImport(Library)]
    private static partial int seccomp_attr_set(nint context, int attribute, uint value);

    [LibraryImport(Library, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int seccomp_syscall_resolve_name(string name);

    [LibraryImport(Library)]
    private static unsafe partial int seccomp_rule_add_array(
        nint context,
        uint action,
        int syscall,
        uint count,
        Comparison* args
    );

    [LibraryImport(Library)]
    private static partial int seccomp_load(nint context);

    [LibraryImport(Library)]
    private static partial void seccomp_release(nint context);

    [LibraryImport("libc")]
    private static partial int getpid();

    [LibraryImport("libc")]
    private static partial int getrlimit(int resource, out Limits limits);

    [StructLayout(LayoutKind.Sequential)]
    private struct Limits
    {
        public ulong Soft,
            Hard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Comparison(uint argument, int op, ulong a, ulong b = 0)
    {
        public uint Argument = argument;
        public int Operator = op;
        public ulong A = a,
            B = b;
    }

    internal static unsafe bool Enter()
    {
        // prlimit installs both hard and soft limits before the native runtime starts. A direct
        // invocation without these ceilings must fail before reading any media, too.
        if (!Capped(9, 1UL << 30) || !Capped(0, 10) || !Capped(4, 0))
            return false;
        var ctx = seccomp_init(0x80000000); // SCMP_ACT_KILL_PROCESS
        if (ctx == 0)
            return false;
        try
        {
            if (seccomp_attr_set(ctx, 4, 1) != 0)
                return false; // CTL_TSYNC: includes runtime threads
            bool Allow(string call, params ReadOnlySpan<Comparison> comparisons)
            {
                int number = seccomp_syscall_resolve_name(call);
                if (number == -1)
                    return false;
                fixed (Comparison* ptr = comparisons)
                    return seccomp_rule_add_array(
                            ctx,
                            0x7fff0000,
                            number,
                            (uint)comparisons.Length,
                            ptr
                        ) == 0;
            }
            // No open, socket, exec, clone, process inspection, unrestricted FD operations, or
            // file-backed mmap. The only accessible external data streams are our dedicated pipes.
            foreach (
                string call in new[]
                {
                    "brk",
                    "munmap",
                    "mprotect",
                    "madvise",
                    "futex",
                    "getpid",
                    "gettid",
                    "clock_gettime",
                    "sched_yield",
                    "rt_sigprocmask",
                    "rt_sigreturn",
                    "sigaltstack",
                    "exit",
                    "exit_group",
                    "getrandom",
                    "restart_syscall",
                }
            )
                if (!Allow(call))
                    return false;
            const int eq = 4,
                maskedEq = 7;
            return Allow("read", new Comparison(0, eq, 0))
                && Allow("write", new Comparison(0, eq, 1))
                && Allow("mmap", new Comparison(3, maskedEq, 0x23, 0x22)) // MAP_PRIVATE|MAP_ANONYMOUS
                && Allow("sched_getaffinity", new Comparison(0, eq, 0))
                && Allow("tgkill", new Comparison(0, eq, (uint)getpid()))
                && seccomp_load(ctx) == 0;
        }
        finally
        {
            seccomp_release(ctx);
        }
    }

    private static bool Capped(int resource, ulong max) =>
        getrlimit(resource, out var r) == 0 && r.Hard <= max;
}
