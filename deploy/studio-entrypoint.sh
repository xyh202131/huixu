#!/bin/sh
set -eu
umask 077
if [ "$(id -u)" = 0 ]; then
  # 新建父目录时允许 node 穿过目录，数据目录本身仍由 node 独占。
  (umask 022; mkdir -p -- "$(dirname -- "$HUIXU_DATA_DIR")")
  mkdir -p -- "$HUIXU_DATA_DIR"
  chown node:node -- "$HUIXU_DATA_DIR"
  exec gosu node "$@"
fi
mkdir -p -- "$HUIXU_DATA_DIR"
exec "$@"
