#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#ifdef __APPLE__
#include <util.h>
#include <dlfcn.h>
#include <limits.h>
#include <string.h>
#include <pthread.h>
#else
#include <pty.h>
#endif
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#ifndef __APPLE__
#include <sys/eventfd.h>
#endif
#include <sys/ioctl.h>
#ifndef __APPLE__
#include <sys/syscall.h>
#endif
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#ifdef FOXWARM_STATIC_MUSL
#include "foxwarm-pty-spawn-musl.h"
#endif

typedef struct {
    int master, cancel, pidfd;
#ifdef __APPLE__
    int cancel_write;
    pthread_mutex_t reap_mutex;
#endif
    pid_t pid, session;
    atomic_int cancelled, reading, writing, wait_started, reaped, active_read, active_write;
} fw_pty;
static atomic_int owned_fds;
static void own_close(int fd) { if (fd >= 0) { close(fd); atomic_fetch_sub(&owned_fds, 1); } }
int fw_owned_fds(void) { return atomic_load(&owned_fds); }
#ifndef __APPLE__
static int pidfd_open_owned(pid_t pid) { int fd = (int)syscall(SYS_pidfd_open, pid, 0); if (fd >= 0) atomic_fetch_add(&owned_fds, 1); return fd; }
#endif

fw_pty *fw_spawn(const char *exe, char *const argv[], char *const env[], const char *cwd, unsigned short cols, unsigned short rows, int *error) {
    int master = -1, slave = -1, cancel = -1, pidfd = -1, rc; pid_t pid = -1;
#ifdef __APPLE__
    int cancel_write = -1, mutex_ready = 0, receipt_read = -1, receipt_write = -1;
    char **helper_argv = NULL;
#endif
    char slave_path[128]; struct termios term = {0}; struct winsize size = {.ws_row = rows, .ws_col = cols};
#ifndef FOXWARM_STATIC_MUSL
    posix_spawnattr_t attr; posix_spawn_file_actions_t actions; int attr_ready = 0, actions_ready = 0;
#endif
    fw_pty *handle = calloc(1, sizeof(*handle)); if (!handle) { *error = ENOMEM; return NULL; }
#ifdef __APPLE__
    if ((rc = pthread_mutex_init(&handle->reap_mutex, NULL))) goto fail;
    mutex_ready = 1;
#endif
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
#ifdef __APPLE__
    int cancellation[2];
    if (pipe(cancellation) < 0) { rc = errno; goto fail; }
    cancel = cancellation[0]; cancel_write = cancellation[1]; atomic_fetch_add(&owned_fds, 2);
    for (int i = 0; i < 2; i++) {
        int f = fcntl(cancellation[i], F_GETFL);
        if (f < 0 || fcntl(cancellation[i], F_SETFL, f | O_NONBLOCK) < 0 ||
            fcntl(cancellation[i], F_SETFD, FD_CLOEXEC) < 0) { rc = errno; goto fail; }
    }
#else
    cancel = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK); if (cancel < 0) { rc = errno; goto fail; } atomic_fetch_add(&owned_fds, 1);
#endif
#ifdef FOXWARM_STATIC_MUSL
    rc = fw_musl_spawn(&pid, exe, argv, env, cwd, slave_path); if (rc) goto fail;
#else
    if ((rc = posix_spawnattr_init(&attr))) goto fail;
    attr_ready = 1;
    if ((rc = posix_spawn_file_actions_init(&actions))) goto fail;
    actions_ready = 1;
    sigset_t defaults, mask; sigfillset(&defaults); sigemptyset(&mask);
    short spawn_flags = POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK;
#ifdef __APPLE__
    spawn_flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;
    // This spelling also supports SDKs before the POSIX addchdir alias appeared.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#endif
    if ((rc = posix_spawnattr_setsigdefault(&attr, &defaults)) || (rc = posix_spawnattr_setsigmask(&attr, &mask)) ||
        (rc = posix_spawnattr_setflags(&attr, spawn_flags)) ||
        (rc = posix_spawn_file_actions_addchdir_np(&actions, cwd)) ||
        (rc = posix_spawn_file_actions_addopen(&actions, 0, slave_path, O_RDWR, 0)) ||
        (rc = posix_spawn_file_actions_adddup2(&actions, 0, 1)) ||
        (rc = posix_spawn_file_actions_adddup2(&actions, 0, 2))) goto fail;
#ifdef __APPLE__
#pragma clang diagnostic pop
#else
    if ((rc = posix_spawn_file_actions_addclosefrom_np(&actions, 3))) goto fail;
#endif
#ifdef __APPLE__
    Dl_info library;
    if (!dladdr((const void *)fw_spawn, &library) || !library.dli_fname) { rc = ENOENT; goto fail; }
    char helper[PATH_MAX];
    const char *slash = strrchr(library.dli_fname, '/');
    if (!slash || (size_t)(slash - library.dli_fname) + sizeof("/foxwarm-pty-helper") > sizeof(helper)) { rc = ENAMETOOLONG; goto fail; }
    size_t directory_length = (size_t)(slash - library.dli_fname);
    memcpy(helper, library.dli_fname, directory_length);
    strcpy(helper + directory_length, "/foxwarm-pty-helper");
    size_t argc = 0; while (argv[argc]) argc++;
    helper_argv = calloc(argc + 2, sizeof(char *));
    if (!helper_argv) { rc = ENOMEM; goto fail; }
    helper_argv[0] = helper;
    helper_argv[1] = (char *)exe;
    for (size_t i = 1; i < argc; i++) helper_argv[i + 1] = argv[i];
    int receipt[2];
    if (pipe(receipt) < 0) { rc = errno; goto fail; }
    receipt_read = receipt[0]; receipt_write = receipt[1]; atomic_fetch_add(&owned_fds, 2);
    if (fcntl(receipt_read, F_SETFD, FD_CLOEXEC) < 0 || fcntl(receipt_write, F_SETFD, FD_CLOEXEC) < 0) { rc = errno; goto fail; }
    if ((rc = posix_spawn_file_actions_adddup2(&actions, receipt_write, 3))) goto fail;
    rc = posix_spawn(&pid, helper, &actions, &attr, helper_argv, env);
    free(helper_argv); helper_argv = NULL;
    if (rc) goto fail;
    own_close(receipt_write); receipt_write = -1;
    int child_error = 0; size_t received = 0;
    while (received < sizeof(child_error)) {
        struct pollfd ready = {receipt_read, POLLIN, 0};
        int polled; do { polled = poll(&ready, 1, 10000); } while (polled < 0 && errno == EINTR);
        if (polled <= 0) { child_error = polled == 0 ? ETIMEDOUT : errno; break; }
        ssize_t n = read(receipt_read, (unsigned char *)&child_error + received, sizeof(child_error) - received);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { child_error = errno; break; }
        if (n == 0) { if (received) child_error = EIO; break; }
        received += (size_t)n;
    }
    own_close(receipt_read); receipt_read = -1;
    if (child_error) { rc = child_error; kill(pid, SIGKILL); while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {} goto fail; }
#else
    rc = posix_spawnp(&pid, exe, &actions, &attr, argv, env); if (rc) goto fail;
#endif
#endif
#ifndef __APPLE__
    pidfd = pidfd_open_owned(pid);
    if (pidfd < 0) { rc = errno; kill(pid, SIGKILL); while (waitpid(pid, NULL, 0) < 0 && errno == EINTR) {} goto fail; }
#endif
#ifndef FOXWARM_STATIC_MUSL
    posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attr);
#endif
    own_close(slave);
    handle->master = master; handle->cancel = cancel; handle->pidfd = pidfd; handle->pid = pid; handle->session = pid;
#ifdef __APPLE__
    handle->cancel_write = cancel_write;
#endif
    *error = 0; return handle;
fail:
#ifndef FOXWARM_STATIC_MUSL
    if (actions_ready) posix_spawn_file_actions_destroy(&actions);
    if (attr_ready) posix_spawnattr_destroy(&attr);
#endif
#ifdef __APPLE__
    own_close(cancel_write); own_close(receipt_read); own_close(receipt_write); free(helper_argv);
    if (mutex_ready) pthread_mutex_destroy(&handle->reap_mutex);
#endif
    own_close(master); own_close(slave); own_close(cancel); own_close(pidfd); free(handle); *error = rc; return NULL;
}
int fw_pid(fw_pty *h) { return h->pid; }
int fw_session(fw_pty *h) {
#ifdef __APPLE__
    // Darwin does not expose tcgetsid on the master. The helper has verified
    // TIOCSCTTY before its exec receipt; this unreaped child owns that session.
    pid_t sid = getsid(h->pid);
#else
    pid_t sid = tcgetsid(h->master);
#endif
    return sid < 0 ? -errno : sid;
}
int fw_foreground(fw_pty *h) { pid_t pg = tcgetpgrp(h->master); return pg < 0 ? -errno : pg; }
int fw_resize(fw_pty *h, unsigned short cols, unsigned short rows) { struct winsize s = {.ws_row = rows, .ws_col = cols}; return ioctl(h->master, TIOCSWINSZ, &s) < 0 ? errno : 0; }
int fw_waiting(fw_pty *h, int writing) { return atomic_load(writing ? &h->writing : &h->reading); }
void fw_cancel(fw_pty *h) { if (!atomic_exchange(&h->cancelled, 1)) { uint64_t one = 1; ssize_t n; do { n = write(
#ifdef __APPLE__
        h->cancel_write,
#else
        h->cancel,
#endif
        &one, sizeof(one)); } while (n < 0 && errno == EINTR); } }
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
#ifdef __APPLE__
int fw_signal_shell(fw_pty *h, int signal) {
    pthread_mutex_lock(&h->reap_mutex);
    int rc = atomic_load(&h->reaped) ? ESRCH : (kill(h->pid, signal) < 0 ? errno : 0);
    pthread_mutex_unlock(&h->reap_mutex); return rc;
}
#else
int fw_signal_shell(fw_pty *h, int signal) { return syscall(SYS_pidfd_send_signal, h->pidfd, signal, NULL, 0) < 0 ? errno : 0; }
#endif
int fw_signal_foreground(fw_pty *h, int signal) {
#ifdef __APPLE__
    pthread_mutex_lock(&h->reap_mutex);
    if (atomic_load(&h->reaped)) { pthread_mutex_unlock(&h->reap_mutex); return ESRCH; }
#endif
    int sid = fw_session(h), group = fw_foreground(h);
    int rc = sid != h->session || group <= 0 ? EPERM
        : group == h->pid ? 0 : (kill(-group, signal) < 0 ? errno : 0);
#ifdef __APPLE__
    pthread_mutex_unlock(&h->reap_mutex);
#endif
    return rc;
}
int fw_wait(fw_pty *h, int *code, int *signal) {
    if (atomic_exchange(&h->wait_started, 1)) return EALREADY;
    int status, error = 0; pid_t got;
#ifdef __APPLE__
    // Nonblocking reap and signal share the mutex: a PID cannot be recycled
    // between a successful reap and a later signal. Never hold it while waiting.
    for (;;) {
        // Darwin's tty close can wait for undrained output even after SIGKILL.
        // Once the reader was explicitly cancelled, discard that output so the
        // owned shell can finish exiting; ordinary output is still read normally.
        if (atomic_load(&h->cancelled)) tcflush(h->master, TCIOFLUSH);
        pthread_mutex_lock(&h->reap_mutex);
        do { got = waitpid(h->pid, &status, WNOHANG); } while (got < 0 && errno == EINTR);
        error = got < 0 ? errno : 0;
        if (got > 0) atomic_store(&h->reaped, 1);
        pthread_mutex_unlock(&h->reap_mutex);
        if (got != 0) break;
        poll(NULL, 0, 50);
    }
#else
    do { got = waitpid(h->pid, &status, 0); } while (got < 0 && errno == EINTR);
    error = got < 0 ? errno : 0;
    if (!error) atomic_store(&h->reaped, 1);
#endif
    if (error) return error;
    *code = WIFEXITED(status) ? WEXITSTATUS(status) : 0;
    *signal = WIFSIGNALED(status) ? WTERMSIG(status) : 0; return 0;
}
int fw_release(fw_pty *h) {
    if (!atomic_load(&h->reaped) || atomic_load(&h->active_read) || atomic_load(&h->active_write)) return EBUSY;
    own_close(h->master); own_close(h->cancel); own_close(h->pidfd);
#ifdef __APPLE__
    own_close(h->cancel_write); pthread_mutex_destroy(&h->reap_mutex);
#endif
    free(h); return 0;
}
