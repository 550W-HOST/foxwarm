/* Focused native PTY boundary probe; compile against the production source.
 * The same probe can exercise the unchanged glibc and static-musl branches. */
#define _GNU_SOURCE
#include <assert.h>
#include <dirent.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <stddef.h>
#include <pthread.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include "../../dotnet/Foxwarm.NodePrimitives/Terminal/native/foxwarm-pty.c"

extern char **environ;
static char executable[PATH_MAX];
static char directory[] = "/tmp/fw-pty-native-XXXXXX";
static atomic_int churn_done;

static void deadline_wait(atomic_int *value) {
    for (int i = 0; i < 5000; i++) {
        if (atomic_load(value)) return;
        usleep(1000);
    }
    assert(!"native operation did not settle");
}

static int descriptor_count(void) {
    DIR *fds = opendir("/proc/self/fd");
    assert(fds);
    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(fds))) if (entry->d_name[0] != '.') count++;
    closedir(fds);
    return count;
}

static int child_entry(const char *mode) {
    assert(descriptor_count() == 4); /* stdio plus this check's directory fd */
    struct sigaction action;
    assert(sigaction(SIGUSR1, NULL, &action) == 0 && action.sa_handler == SIG_DFL);
    sigset_t mask;
    assert(pthread_sigmask(SIG_SETMASK, NULL, &mask) == 0);
    for (int signal = 1; signal < NSIG; signal++) assert(sigismember(&mask, signal) != 1);
    assert(getsid(0) == getpid() && tcgetsid(0) == getpid());
    assert(tcgetpgrp(0) == getpid());
    char cwd[PATH_MAX];
    assert(getcwd(cwd, sizeof(cwd)) && strcmp(cwd, getenv("FW_PTY_PROBE_CWD")) == 0);
    if (strcmp(mode, "exit") == 0) return 17;
    struct winsize size;
    assert(ioctl(0, TIOCGWINSZ, &size) == 0 && size.ws_col == 91 && size.ws_row == 37);
    puts("READY-é雪🙂");
    fflush(stdout);
    char input;
    while (read(0, &input, 1) == 1) {
        if (input == 'R') {
            assert(ioctl(0, TIOCGWINSZ, &size) == 0 && size.ws_col == 103 && size.ws_row == 41);
            puts("RESIZED");
            fflush(stdout);
        }
    }
    return 0;
}

static fw_pty *spawn_mode(const char *exe, const char *cwd, const char *mode, int *error) {
    char *argv[] = {(char *)exe, "--child", (char *)mode, NULL};
    return fw_spawn(exe, argv, environ, cwd, 91, 37, error);
}

static void assert_reaped(pid_t pid) {
    assert(waitpid(pid, NULL, WNOHANG) == -1 && errno == ECHILD);
}

static void finish(fw_pty *handle, int expected_code, int expected_signal) {
    pid_t pid = fw_pid(handle);
    int code, signal;
    assert(fw_wait(handle, &code, &signal) == 0);
    assert(code == expected_code && signal == expected_signal);
    assert(fw_wait(handle, &code, &signal) == EALREADY);
    assert(fw_release(handle) == 0);
    assert_reaped(pid);
}

static void *churn(void *unused) {
    (void)unused;
    while (!atomic_load(&churn_done)) {
        int fd = open("/dev/null", O_RDONLY);
        assert(fd >= 0);
        close(fd);
    }
    return NULL;
}

struct io_operation { fw_pty *handle; atomic_int done; long result; };
static void *read_wait(void *argument) {
    struct io_operation *operation = argument;
    unsigned char byte;
    operation->result = fw_read(operation->handle, &byte, 1);
    atomic_store(&operation->done, 1);
    return NULL;
}
static void *write_wait(void *argument) {
    struct io_operation *operation = argument;
    unsigned char *bytes = malloc(4 * 1024 * 1024);
    assert(bytes);
    memset(bytes, 'x', 4 * 1024 * 1024);
    size_t done;
    operation->result = fw_write(operation->handle, bytes, 4 * 1024 * 1024, &done);
    free(bytes);
    atomic_store(&operation->done, 1);
    return NULL;
}

static void wait_native_io(fw_pty *handle, int writing) {
    for (int i = 0; i < 5000; i++) {
        if (fw_waiting(handle, writing)) return;
        usleep(1000);
    }
    assert(!"native IO did not block");
}

static void read_until(fw_pty *handle, const char *needle) {
    char output[16384] = {0};
    size_t used = 0;
    while (!strstr(output, needle)) {
        assert(used + 1 < sizeof(output));
        long count = fw_read(handle, (unsigned char *)output + used, sizeof(output) - used - 1);
        assert(count > 0);
        used += (size_t)count;
        output[used] = 0;
    }
}

static void install_filter(int reject_proc_enumeration) {
    struct sock_filter filter[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_close_range, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, reject_proc_enumeration ? SYS_getdents64 : UINT_MAX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {.len = sizeof(filter) / sizeof(filter[0]), .filter = filter};
    assert(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0);
    assert(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0);
}

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "--child") == 0) return child_entry(argv[2]);
    ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    assert(length > 0);
    executable[length] = 0;
    assert(mkdtemp(directory));
    assert(setenv("FW_PTY_PROBE_CWD", directory, 1) == 0);
    int original_fds = descriptor_count(), error;
    int null_fd = open("/dev/null", O_RDONLY);
    assert(null_fd >= 0);
    int low = fcntl(null_fd, F_DUPFD, 77), high = fcntl(null_fd, F_DUPFD, 511);
    assert(low >= 77 && high >= 511);
    close(null_fd);
    if (argc == 2 && strcmp(argv[1], "--fallback") == 0) install_filter(0);
    if (argc == 2 && strcmp(argv[1], "--no-close-mechanism") == 0) {
        /* A process wrapper may own a live timer child. Run this failure
         * check in a fresh process, then reap that exact fixture child. */
        pid_t isolated = fork();
        assert(isolated >= 0);
        if (!isolated) {
            assert(waitpid(-1, NULL, WNOHANG) == -1 && errno == ECHILD);
            install_filter(1);
            assert(spawn_mode(executable, directory, "exit", &error) == NULL && error == EACCES);
            assert(fw_owned_fds() == 0);
            assert(waitpid(-1, NULL, WNOHANG) == -1 && errno == ECHILD);
            _exit(0);
        }
        int status;
        assert(waitpid(isolated, &status, 0) == isolated && WIFEXITED(status) && WEXITSTATUS(status) == 0);
        close(low); close(high); rmdir(directory);
        puts("native PTY close-all failure reported and child reaped");
        return 0;
    }
    struct sigaction original_action, ignored = {.sa_handler = SIG_IGN};
    sigemptyset(&ignored.sa_mask);
    assert(sigaction(SIGUSR1, &ignored, &original_action) == 0);
    sigset_t block, old_mask, after_mask;
    sigemptyset(&block); sigaddset(&block, SIGUSR1);
    assert(pthread_sigmask(SIG_BLOCK, &block, &old_mask) == 0);
    pthread_t churn_thread;
    assert(pthread_create(&churn_thread, NULL, churn, NULL) == 0);
    for (int i = 0; i < 12; i++) {
        fw_pty *handle = spawn_mode(executable, directory, "exit", &error);
        assert(handle && !error);
        finish(handle, 17, 0);
    }
    atomic_store(&churn_done, 1);
    assert(pthread_join(churn_thread, NULL) == 0);
    assert(pthread_sigmask(SIG_SETMASK, NULL, &after_mask) == 0 && sigismember(&after_mask, SIGUSR1) == 1);
    struct sigaction after_action;
    assert(sigaction(SIGUSR1, NULL, &after_action) == 0 && after_action.sa_handler == SIG_IGN);

    assert(spawn_mode(executable, "/nonexistent-foxwarm-pty-cwd", "exit", &error) == NULL && error == ENOENT);
    assert(spawn_mode("/nonexistent-foxwarm-pty-shell", directory, "exit", &error) == NULL && error == ENOENT);
    char denied[PATH_MAX], allowed[PATH_MAX], candidate[PATH_MAX];
    assert(snprintf(denied, sizeof(denied), "%s/denied", directory) > 0);
    assert(snprintf(allowed, sizeof(allowed), "%s/allowed", directory) > 0);
    assert(mkdir(denied, 0700) == 0 && mkdir(allowed, 0700) == 0);
    assert(snprintf(candidate, sizeof(candidate), "%s/denied/probe", directory) > 0);
    int denied_file = open(candidate, O_CREAT | O_WRONLY, 0600);
    assert(denied_file >= 0); close(denied_file);
    assert(spawn_mode(candidate, directory, "exit", &error) == NULL && error == EACCES);
    assert(snprintf(candidate, sizeof(candidate), "%s/allowed/probe", directory) > 0);
    assert(symlink(executable, candidate) == 0);
    char *old_path = getenv("PATH") ? strdup(getenv("PATH")) : NULL;
    assert(setenv("PATH", "denied:allowed", 1) == 0);
    fw_pty *handle = spawn_mode("probe", directory, "exit", &error);
    assert(handle && !error); finish(handle, 17, 0);
    assert(setenv("PATH", "denied", 1) == 0);
    assert(spawn_mode("probe", directory, "exit", &error) == NULL && error == EACCES);
    if (old_path) { assert(setenv("PATH", old_path, 1) == 0); free(old_path); }
    else assert(unsetenv("PATH") == 0);

    handle = spawn_mode(executable, directory, "interactive", &error);
    assert(handle && !error);
    read_until(handle, "READY-é雪🙂\r\n");
    assert(fw_resize(handle, 103, 41) == 0);
    size_t written;
    assert(fw_write(handle, (const unsigned char *)"R\n", 2, &written) == 0 && written == 2);
    read_until(handle, "RESIZED\r\n");
    struct io_operation reading = {.handle = handle};
    pthread_t io_thread;
    assert(pthread_create(&io_thread, NULL, read_wait, &reading) == 0);
    wait_native_io(handle, 0);
    assert(fw_release(handle) == EBUSY);
    fw_cancel(handle); deadline_wait(&reading.done);
    assert(pthread_join(io_thread, NULL) == 0 && reading.result == -ECANCELED);
    assert(fw_signal_shell(handle, SIGTERM) == 0);
    finish(handle, 0, SIGTERM);

    handle = spawn_mode(executable, directory, "interactive", &error);
    assert(handle && !error); read_until(handle, "READY-é雪🙂\r\n");
    /* Stop the exact shell so input cannot drain, then cancel a real full PTY. */
    assert(fw_signal_shell(handle, SIGSTOP) == 0);
    struct io_operation writing = {.handle = handle};
    assert(pthread_create(&io_thread, NULL, write_wait, &writing) == 0);
    wait_native_io(handle, 1);
    fw_cancel(handle); deadline_wait(&writing.done);
    assert(pthread_join(io_thread, NULL) == 0 && writing.result == ECANCELED);
    assert(fw_signal_shell(handle, SIGKILL) == 0);
    finish(handle, 0, SIGKILL);

    pid_t closed_stdio = fork();
    assert(closed_stdio >= 0);
    if (!closed_stdio) {
        close(0); close(1); close(2);
        handle = spawn_mode(executable, directory, "exit", &error);
        if (!handle || error) _exit(101);
        int code, signal;
        if (fw_wait(handle, &code, &signal) || code != 17 || signal || fw_release(handle)) _exit(102);
        _exit(0);
    }
    int status;
    assert(waitpid(closed_stdio, &status, 0) == closed_stdio && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    assert(pthread_sigmask(SIG_SETMASK, &old_mask, NULL) == 0);
    assert(sigaction(SIGUSR1, &original_action, NULL) == 0);
    close(low); close(high);
    assert(fw_owned_fds() == 0 && descriptor_count() == original_fds);
    unlink(candidate);
    assert(snprintf(candidate, sizeof(candidate), "%s/denied/probe", directory) > 0);
    unlink(candidate); rmdir(denied); rmdir(allowed); rmdir(directory);
    puts("native PTY cwd/session/signals/fds/PATH/errors/resize/cancel/reaping passed");
    return 0;
}
