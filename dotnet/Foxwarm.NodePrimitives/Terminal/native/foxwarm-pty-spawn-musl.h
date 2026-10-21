/* The static musl target has no posix_spawn close-from action. Keep this
 * pre-exec child entirely native: a private fd table, raw syscalls, and a
 * CLOEXEC error pipe. In particular, never enter managed code, allocation,
 * libc fork handlers, or libc directory/stdio locks in the child. */
#include <limits.h>
#include <stddef.h>
#include <string.h>

struct fw_spawn_paths {
    char **values;
    size_t count;
};

static void fw_free_paths(struct fw_spawn_paths *paths) {
    for (size_t i = 0; i < paths->count; i++) free(paths->values[i]);
    free(paths->values);
}

/* Match musl's spawnp search: use the caller's PATH, not the supplied envp;
 * retain relative/empty components for lookup after the child changes cwd. */
static int fw_prepare_paths(const char *exe, struct fw_spawn_paths *paths) {
    if (!*exe) return ENOENT;
    if (strchr(exe, '/')) {
        paths->values = calloc(1, sizeof(char *));
        if (!paths->values) return ENOMEM;
        paths->values[0] = strdup(exe);
        if (!paths->values[0]) return ENOMEM;
        paths->count = 1;
        return 0;
    }
    size_t name_length = strnlen(exe, NAME_MAX + 1);
    if (name_length > NAME_MAX) return ENAMETOOLONG;
    const char *environment_path = getenv("PATH");
    char *path = strdup(environment_path ? environment_path : "/usr/local/bin:/bin:/usr/bin");
    if (!path) return ENOMEM;
    size_t capacity = 1;
    for (const char *p = path; *p; p++) if (*p == ':') capacity++;
    paths->values = calloc(capacity, sizeof(char *));
    if (!paths->values) { free(path); return ENOMEM; }
    size_t component_limit = strnlen(path, PATH_MAX - 1) + 1;
    for (char *p = path;;) {
        char *end = strchr(p, ':');
        size_t length = end ? (size_t)(end - p) : strlen(p);
        if (length < component_limit) {
            char *candidate = malloc(length + name_length + 2);
            if (!candidate) { free(path); return ENOMEM; }
            memcpy(candidate, p, length);
            if (length) candidate[length++] = '/';
            memcpy(candidate + length, exe, name_length + 1);
            paths->values[paths->count++] = candidate;
        }
        if (!end) break;
        p = end + 1;
    }
    free(path);
    return 0;
}

struct fw_kernel_sigaction {
    void (*handler)(int);
    unsigned long flags;
    void (*restorer)(void);
    uint64_t mask;
};

struct fw_linux_dirent64 {
    uint64_t ino;
    int64_t offset;
    unsigned short length;
    unsigned char type;
    char name[];
};

static int fw_child_close_fds(int error_fd) {
    int first_error = 0;
    if (error_fd > 3 && syscall(SYS_close_range, 3U, (unsigned)(error_fd - 1), 0U) < 0)
        first_error = errno;
    if (syscall(SYS_close_range, (unsigned)error_fd + 1U, UINT_MAX, 0U) < 0)
        first_error = errno;
    if (!first_error) return 0;

    /* Enumerate this child's private table, not a parent-side snapshot. This
     * preserves close-from on kernels or policies without close_range. */
    int directory = (int)syscall(SYS_openat, AT_FDCWD, "/proc/self/fd", O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
    if (directory < 0) return errno;
    _Alignas(uint64_t) char buffer[4096];
    for (;;) {
        long count = syscall(SYS_getdents64, directory, buffer, sizeof(buffer));
        if (count < 0) {
            if (errno == EINTR) continue;
            int error = errno;
            syscall(SYS_close, directory);
            return error;
        }
        if (!count) break;
        for (long offset = 0; offset < count;) {
            struct fw_linux_dirent64 *entry = (void *)(buffer + offset);
            offset += entry->length;
            if (entry->name[0] == '.') continue;
            int fd = 0;
            for (const char *p = entry->name; *p; p++) fd = fd * 10 + (*p - '0');
            if (fd > 2 && fd != directory && fd != error_fd) syscall(SYS_close, fd);
        }
    }
    syscall(SYS_close, directory);
    return 0;
}

static void fw_child_exec(const struct fw_spawn_paths *paths, char *const argv[], char *const env[],
                          const char *cwd, const char *slave_path, int error_fd) {
    int error = 0;
    struct fw_kernel_sigaction action = {0};
    for (int signal = 1; signal <= 64; signal++) {
        if (signal == SIGKILL || signal == SIGSTOP) continue;
        if (syscall(SYS_rt_sigaction, signal, &action, NULL, sizeof(uint64_t)) < 0) {
            error = errno;
            goto fail;
        }
    }
    if (syscall(SYS_setsid) < 0 || syscall(SYS_chdir, cwd) < 0) { error = errno; goto fail; }
    int slave = (int)syscall(SYS_openat, AT_FDCWD, slave_path, O_RDWR, 0);
    if (slave < 0) { error = errno; goto fail; }
    if (syscall(SYS_dup2, slave, 0) < 0 || syscall(SYS_dup2, 0, 1) < 0 || syscall(SYS_dup2, 0, 2) < 0) {
        error = errno;
        goto fail;
    }
    if ((error = fw_child_close_fds(error_fd))) goto fail;
    uint64_t empty_mask = 0;
    if (syscall(SYS_rt_sigprocmask, SIG_SETMASK, &empty_mask, NULL, sizeof(empty_mask)) < 0) {
        error = errno;
        goto fail;
    }
    int denied = 0;
    for (size_t i = 0; i < paths->count; i++) {
        syscall(SYS_execve, paths->values[i], argv, env);
        error = errno;
        if (error == EACCES) denied = 1;
        else if (error != ENOENT && error != ENOTDIR) goto fail;
    }
    error = denied ? EACCES : ENOENT;
fail:
    while (syscall(SYS_write, error_fd, &error, sizeof(error)) < 0 && errno == EINTR) {}
    syscall(SYS_exit, 127);
    __builtin_unreachable();
}

static int fw_musl_spawn(pid_t *pid, const char *exe, char *const argv[], char *const env[],
                         const char *cwd, const char *slave_path) {
    struct fw_spawn_paths paths = {0};
    int error = fw_prepare_paths(exe, &paths);
    if (error) { fw_free_paths(&paths); return error; }
    int pipe_fds[2];
    if (pipe2(pipe_fds, O_CLOEXEC) < 0) { error = errno; fw_free_paths(&paths); return error; }
    for (int i = 0; i < 2; i++) {
        if (pipe_fds[i] > 2) continue;
        int moved = fcntl(pipe_fds[i], F_DUPFD_CLOEXEC, 3);
        if (moved < 0) { error = errno; goto done; }
        close(pipe_fds[i]);
        pipe_fds[i] = moved;
    }

    /* The x64 static target uses raw fork, not libc fork/atfork callbacks.
     * Block even libc-private signals until the child has reset dispositions.
     * Child code below only uses syscall(), stack storage and copied inputs;
     * it does not need libc's copied thread IDs or potentially held locks. */
    uint64_t blocked = UINT64_MAX, old_mask;
    if (syscall(SYS_rt_sigprocmask, SIG_SETMASK, &blocked, &old_mask, sizeof(blocked)) < 0) {
        error = errno;
        goto done;
    }
    pid_t child = (pid_t)syscall(SYS_fork);
    int fork_error = errno;
    if (!child) {
        syscall(SYS_close, pipe_fds[0]);
        fw_child_exec(&paths, argv, env, cwd, slave_path, pipe_fds[1]);
    }
    syscall(SYS_rt_sigprocmask, SIG_SETMASK, &old_mask, NULL, sizeof(old_mask));
    if (child < 0) { error = fork_error; goto done; }
    close(pipe_fds[1]);
    pipe_fds[1] = -1;
    unsigned char *destination = (void *)&error;
    size_t received = 0;
    while (received < sizeof(error)) {
        ssize_t count = read(pipe_fds[0], destination + received, sizeof(error) - received);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { error = errno; kill(child, SIGKILL); break; }
        if (!count) break;
        received += (size_t)count;
    }
    if (received && received != sizeof(error)) { error = EIO; kill(child, SIGKILL); }
    if (error) {
        while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
    } else {
        *pid = child;
    }
done:
    close(pipe_fds[0]);
    if (pipe_fds[1] >= 0) close(pipe_fds[1]);
    fw_free_paths(&paths);
    return error;
}
