#!/bin/sh
set -eu
export VK_ICD_FILENAMES="$(cat /app/docker/lavapipe-icd)"
if [ -z "$VK_ICD_FILENAMES" ]; then
  echo 'Mesa Lavapipe Vulkan driver is missing' >&2
  exit 1
fi
if [ "$#" -gt 0 ] && [ "$1" != '--describe' ]; then
  exec "$@"
fi
exec python3 /app/docker/dockergrid.py "$@"
