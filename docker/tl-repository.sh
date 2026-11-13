#!/bin/sh
# Print the TeX Live repository for TL_YEAR: its tlnet-final, else a CTAN mirror that still serves it.
# mirror.ctan.org redirects each request to a random mirror, so resolve it once per layer.
set -eu

final="${TL_HISTORIC}/${TL_YEAR}/tlnet-final"
if curl -fsSI "${final}/tlpkg/texlive.tlpdb.sha512" > /dev/null; then
    echo "${final}"
    exit 0
fi
if ! mirror="$(curl -fsSIL -o /dev/null -w '%{url_effective}' "${TL_MIRROR}/")"; then
    echo "cannot reach ${TL_MIRROR}" >&2
    exit 1
fi
mirror="${mirror%/}"
if ! curl -fsSI "${mirror}/TEXLIVE_${TL_YEAR}" > /dev/null; then
    echo "no TeX Live ${TL_YEAR} package repository at ${mirror}" >&2
    exit 1
fi
echo "${mirror}"
