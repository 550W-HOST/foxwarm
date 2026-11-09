#!/bin/sh
# Container entry point: start as root only to check the data directory, then run Foxwarm as the
# fixed `node` account (uid 1000). Ownership of the mounted data belongs to the operator.
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
if ! setpriv --reuid="$uid" --regid="$gid" --init-groups test -w "$data"; then
    echo "foxwarm: $data is not writable by $account ($uid:$gid); on the host, run chown -R $uid:$gid on the mounted data directory" >&2
fi

HOME=$home USER=$account LOGNAME=$account
export HOME USER LOGNAME
# setpriv is used without --no-new-privs, so the passwordless sudo configured in the image
# keeps working for the dropped account.
exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"
