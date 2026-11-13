#!/bin/sh
# Print the TeX Live repository for TL_YEAR: its tlnet-final, else a CTAN mirror that still serves it.
# mirror.ctan.org redirects each request to a random mirror, so resolve it once,
# and try again or use a fixed mirror when the one it picks is broken.
set -eu

final="${TL_HISTORIC}/${TL_YEAR}/tlnet-final"
if curl -fsSI "${final}/tlpkg/texlive.tlpdb.sha512" > /dev/null; then
    echo "${final}"
    exit 0
fi

serves_year() {
    curl -fsSI --retry 2 "$1/TEXLIVE_${TL_YEAR}" > /dev/null 2>&1
}

for _ in 1 2 3; do
    if mirror="$(curl -fsSIL -o /dev/null -w '%{url_effective}' "${TL_MIRROR}/" 2>/dev/null)"; then
        mirror="${mirror%/}"
        if serves_year "${mirror}"; then
            echo "${mirror}"
            exit 0
        fi
    fi
done

for mirror in \
    https://mirrors.mit.edu/CTAN/systems/texlive/tlnet \
    https://mirror.math.princeton.edu/pub/CTAN/systems/texlive/tlnet \
    https://ftp.math.utah.edu/pub/ctan/tex-archive/systems/texlive/tlnet; do
    if serves_year "${mirror}"; then
        echo "${mirror}"
        exit 0
    fi
done

echo "no TeX Live ${TL_YEAR} package repository at ${TL_MIRROR} or the fallback mirrors" >&2
exit 1
