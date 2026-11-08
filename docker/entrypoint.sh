#!/bin/sh
# Container entry point: start as root only long enough to make the data directory
# usable by the fixed `node` account (uid 1000), then run Foxwarm as that account.
set -eu

account=node
data=${FOXWARM_DATA_DIR:-/data}

if [ "$(id -u)" != 0 ]; then
    # Started with `--user` or a non-root runtime: nothing to prepare or drop.
    exec "$@"
fi

uid=$(id -u "$account")
gid=$(id -g "$account")
home=$(getent passwd "$account" | cut -d: -f6)

mkdir -p "$data"
# Data written by earlier root-run images is root-owned. Look only at the root and its first two
# levels (state/, agents/ and their children), so a correctly owned installation costs one bounded
# scan instead of a recursive walk, and only then fix the whole tree. Directories owned by some
# other account are left alone.
if [ -n "$(find "$data" -maxdepth 2 -user 0 -print -quit 2>/dev/null)" ]; then
    echo "foxwarm: taking ownership of root-owned files in $data for $account ($uid:$gid)" >&2
    chown -R "$uid:$gid" "$data" ||
        echo "foxwarm: could not change ownership of $data; continuing" >&2
fi
if ! setpriv --reuid="$uid" --regid="$gid" --init-groups test -w "$data"; then
    echo "foxwarm: $data is not writable by $account ($uid:$gid); fix its owner or mode" >&2
fi

HOME=$home USER=$account LOGNAME=$account
export HOME USER LOGNAME
# setpriv is used without --no-new-privs, so the passwordless sudo configured in the image
# keeps working for the dropped account.
exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"
