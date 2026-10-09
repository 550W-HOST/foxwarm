#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pty.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/eventfd.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

typedef struct {
    int master, cancel, pidfd;
    pid_t pid, session;
    atomic_int cancelled, reading, writing, wait_started, reaped, active_read, active_write;
} fw_pty;
static atomic_int owned_fds;
static void own_close(int fd) { if (fd >= 0) { close(fd); atomic_fetch_sub(&owned_fds, 1); } }
int fw_owned_fds(void) { return atomic_load(&owned_fds); }
static int pidfd_open_owned(pid_t pid) { int fd = (int)syscall(SYS_pidfd_open, pid, 0); if (fd >= 0) atomic_fetch_add(&owned_fds, 1); return fd; }

fw_pty *fw_spawn(const char *exe, char *const argv[], char *const env[], const char *cwd, unsigned short cols, unsigned short rows, int *error) {
    int master = -1, slave = -1, cancel = -1, pidfd = -1, rc; pid_t pid = -1;
    char slave_path[128]; struct termios term = {0}; struct winsize size = {.ws_row = rows, .ws_col = cols};
    posix_spawnattr_t attr; posix_spawn_file_actions_t actions; int attr_ready = 0, actions_ready = 0;
    fw_pty *handle = calloc(1, sizeof(*handle)); if (!handle) { *error = ENOMEM; return NULL; }
    term.c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT | IUTF8;
    term.c_oflag = OPOST | ONLCR; term.c_cflag = CREAD | CS8 | HUPCL;
    term.c_lflag = ICANON | ISIG | IEXTEN | ECHO | ECHOE | ECHOK | ECHOKE | ECHOCTL;
    term.c_cc[VEOF] = 4; term.c_cc[VEOL] = 255; term.c_cc[VEOL2] = 255; term.c_cc[VERASE] = 127;
    term.c_cc[VWERASE] = 23; term.c_cc[VKILL] = 21; term.c_cc[VREPRINT] = 18; term.c_cc[VINTR] = 3;
    term.c_cc[VQUIT] = 28; term.c_cc[VSUSP] = 26; term.c_cc[VSTART] = 17; term.c_cc[VSTOP] = 19;
    term.c_cc[VLNEXT] = 22; term.c_cc[VDISCARD] = 15; term.c_cc[VMIN] = 1; term.c_cc[VTIME] = 0;
    cfsetispeed(&term, B38400); cfsetospeed(&term, B38400);
    if (openpty(&master, &slave, slave_path, &term, &size) < 0) { rc = errno; goto fail; }
    atomic_fetch_add(&owned_fds, 2);
    if (fcntl(master, F_SETFD, FD_CLOEXEC) < 0 || fcntl(slave, F_SETFD, FD_CLOEXEC) < 0) { rc = errno; goto fail; }
    int flags = fcntl(master, F_GETFL); if (flags < 0 || fcntl(master, F_SETFL, flags | O_NONBLOCK) < 0) { rc = errno; goto fail; }
    cancel = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK); if (cancel < 0) { rc = errno; goto fail; } atomic_fetch_add(&owned_fds, 1);
    if ((rc = posix_spawnattr_init(&attr))) goto fail;
    attr_ready = 1;
    if ((rc = posix_spawn_file_actions_init(&actions))) goto fail;
    actions_ready = 1;
    sigset_t defaults, mask; sigfillset(&defaults); sigemptyset(&mask);
    if ((rc = posix_spawnattr_setsigdefault(&attr, &defaults)) || (rc = posix_spawnattr_setsigmask(&attr, &mask)) ||
        (rc = posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)) ||
        (rc = posix_spawn_file_actions_addchdir_np(&actions, cwd)) ||
        (rc = posix_spawn_file_actions_addopen(&actions, 0, slave_path, O_RDWR, 0)) ||
        (rc = posix_spawn_file_actions_adddup2(&actions, 0, 1)) ||
        (rc = posix_spawn_file_actions_adddup2(&actions, 0, 2)) ||
        (rc = posix_spawn_file_actions_addclosefrom_np(&actions, 3))) goto fail;
    rc = posix_spawn(&pid, exe, &actions, &attr, argv, env); if (rc) goto fail;
    pidfd = pidfd_open_owned(pid);
    if (pidfd < 0) { rc = errno; kill(pid, SIGKILL); while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {} goto fail; }
    posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attr); own_close(slave);
    handle->master = master; handle->cancel = cancel; handle->pidfd = pidfd; handle->pid = pid; handle->session = pid;
    *error = 0; return handle;
fail:
    if (actions_ready) posix_spawn_file_actions_destroy(&actions);
    if (attr_ready) posix_spawnattr_destroy(&attr);
    own_close(master); own_close(slave); own_close(cancel); own_close(pidfd); free(handle); *error = rc; return NULL;
}
int fw_pid(fw_pty *h) { return h->pid; }
int fw_session(fw_pty *h) { pid_t sid = tcgetsid(h->master); return sid < 0 ? -errno : sid; }
int fw_foreground(fw_pty *h) { pid_t pg = tcgetpgrp(h->master); return pg < 0 ? -errno : pg; }
int fw_resize(fw_pty *h, unsigned short cols, unsigned short rows) { struct winsize s = {.ws_row = rows, .ws_col = cols}; return ioctl(h->master, TIOCSWINSZ, &s) < 0 ? errno : 0; }
int fw_waiting(fw_pty *h, int writing) { return atomic_load(writing ? &h->writing : &h->reading); }
void fw_cancel(fw_pty *h) { if (!atomic_exchange(&h->cancelled, 1)) { uint64_t one = 1; ssize_t n; do { n = write(h->cancel, &one, sizeof(one)); } while (n < 0 && errno == EINTR); } }
static int ready(fw_pty *h, short events, atomic_int *waiting) {
    struct pollfd fds[] = {{h->master, events, 0}, {h->cancel, POLLIN, 0}};
    for (;;) { if (atomic_load(&h->cancelled)) return ECANCELED; atomic_store(waiting, 1); int rc = poll(fds, 2, -1); atomic_store(waiting, 0);
        if (atomic_load(&h->cancelled) || (fds[1].revents & POLLIN)) return ECANCELED;
        if (rc < 0) { if (errno == EINTR) continue; return errno; }
        if (fds[0].revents) return 0;
    }
}
static long read_core(fw_pty *h, unsigned char *buffer, size_t count) { for (;;) { int rc = ready(h, POLLIN, &h->reading); if (rc) return -rc; ssize_t n = read(h->master, buffer, count); if (n >= 0) return n; if (errno == EAGAIN || errno == EINTR) continue; return -errno; } }
long fw_read(fw_pty *h, unsigned char *buffer, size_t count) { atomic_fetch_add(&h->active_read, 1); long result = read_core(h, buffer, count); atomic_fetch_sub(&h->active_read, 1); return result; }
static int write_core(fw_pty *h, const unsigned char *buffer, size_t count, size_t *done) { *done = 0; while (*done < count) { if (atomic_load(&h->cancelled)) return ECANCELED; ssize_t n = write(h->master, buffer + *done, count - *done); if (n > 0) { *done += n; continue; } if (n < 0 && errno == EINTR) continue; if (n < 0 && errno == EAGAIN) { int rc = ready(h, POLLOUT, &h->writing); if (rc) return rc; continue; } return n < 0 ? errno : EIO; } return 0; }
int fw_write(fw_pty *h, const unsigned char *buffer, size_t count, size_t *done) { atomic_fetch_add(&h->active_write, 1); int result = write_core(h, buffer, count, done); atomic_fetch_sub(&h->active_write, 1); return result; }
int fw_signal_shell(fw_pty *h, int signal) { return syscall(SYS_pidfd_send_signal, h->pidfd, signal, NULL, 0) < 0 ? errno : 0; }
int fw_signal_foreground(fw_pty *h, int signal) { int sid = fw_session(h), group = fw_foreground(h); if (sid != h->session || group <= 0) return EPERM; if (group == h->pid) return 0; return kill(-group, signal) < 0 ? errno : 0; }
int fw_wait(fw_pty *h, int *code, int *signal) { if (atomic_exchange(&h->wait_started, 1)) return EALREADY; int status; pid_t got; do { got = waitpid(h->pid, &status, 0); } while (got < 0 && errno == EINTR); if (got < 0) return errno; atomic_store(&h->reaped, 1); *code = WIFEXITED(status) ? WEXITSTATUS(status) : 0; *signal = WIFSIGNALED(status) ? WTERMSIG(status) : 0; return 0; }
int fw_release(fw_pty *h) { if (!atomic_load(&h->reaped) || atomic_load(&h->active_read) || atomic_load(&h->active_write)) return EBUSY; own_close(h->master); own_close(h->cancel); own_close(h->pidfd); free(h); return 0; }
