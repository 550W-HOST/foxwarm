#!/bin/sh
# Entry of the hosted image. The root filesystem is read-only and the scratch directory is an
# empty ephemeral mount, so the temporary directory under it is created here. Commands such as
# `db migrate` or `hosted token` may run without a scratch mount; they don't need it.
mkdir -p "${TMPDIR:-/scratch/.temp}" 2>/dev/null || true
exec /app/Foxwarm "$@"
