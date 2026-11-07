#!/usr/bin/env bash
set -euo pipefail

if (( $# > 1 )); then
    echo "Usage: $0 [output-directory]" >&2
    exit 2
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${1:-"$project_dir/dist"}
for source_file in metadata.json extension.js layout.js history.js compatibility.js syntax-v2.js LICENSE README.md; do
    if [[ ! -f "$project_dir/$source_file" ]]; then
        printf 'Required file is missing: %s\n' "$source_file" >&2
        exit 1
    fi
done
mkdir -p -- "$output_dir"

gnome-extensions pack \
    --extra-source=layout.js \
    --extra-source=history.js \
    --extra-source=compatibility.js \
    --extra-source=syntax-v2.js \
    --extra-source=LICENSE \
    --extra-source=README.md \
    --out-dir="$output_dir" \
    "$project_dir"
