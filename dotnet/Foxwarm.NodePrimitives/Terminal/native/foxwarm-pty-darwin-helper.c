// Single-threaded post-spawn entry: Darwin applies spawn file actions before
// SETSID. Acquire the controlling tty here, then replace this process with the
// requested shell. fd 3 reports setup/exec errno and closes on successful exec.
#include <errno.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static void fail(int error) {
    const unsigned char *p = (const unsigned char *)&error;
    size_t left = sizeof(error);
    while (left) {
        ssize_t n = write(3, p, left);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        p += n; left -= (size_t)n;
    }
    _exit(127);
}
int main(int argc, char **argv) {
    if (argc < 2) fail(EINVAL);
    if (fcntl(3, F_SETFD, FD_CLOEXEC) < 0) fail(errno);
    if (ioctl(STDIN_FILENO, TIOCSCTTY, 0) < 0) fail(errno);
    execvp(argv[1], &argv[1]);
    fail(errno);
    return 127;
}
