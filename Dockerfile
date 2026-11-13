# cv-tools with a minimal TeX Live 2026 that has exactly the packages in packages.txt.
#   docker run --rm --mount "type=bind,source=$PWD,target=/work" ghcr.io/mlsdpk/cv-tools build cv.yaml

ARG PYTHON_IMAGE=python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

FROM ${PYTHON_IMAGE} AS texlive

# The package database's signing subkey expires on 2027-07-13; after that a
# rebuild fails closed and needs a newer TL_YEAR and INSTALL_TL_SHA512.
ARG TL_YEAR=2026
ARG TL_HISTORIC=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive
ARG TL_MIRROR=https://mirror.ctan.org/systems/texlive/tlnet
ARG INSTALL_TL_SHA512=0b80cb3cbe1727d7bed766ed0dfe5012a1c81ee0608689e404d473dd6eff1bd76431711401839a224aa81037083b28470f1278c5276874a34734d1e81e03ea91

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# gnupg lets install-tl and tlmgr check the package database's signature.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg perl xz-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/install-tl

# One layer installs everything from one mirror, since mirrors lag each other by
# a day or so. install-tl only warns about a missing or expired key, so the
# greps require "(verified)".
COPY docker/tl-repository.sh /usr/local/bin/tl-repository
COPY src/cv_tools/templates/latex/packages.txt /tmp/packages.txt

RUN curl -fsSL -o install-tl-unx.tar.gz "${TL_HISTORIC}/${TL_YEAR}/install-tl-unx.tar.gz" \
 && echo "${INSTALL_TL_SHA512}  install-tl-unx.tar.gz" | sha512sum -c - \
 && tar -xzf install-tl-unx.tar.gz --strip-components=1 \
 && repository="$(TL_YEAR="${TL_YEAR}" TL_HISTORIC="${TL_HISTORIC}" TL_MIRROR="${TL_MIRROR}" tl-repository)" \
 && echo "installing TeX Live ${TL_YEAR} from ${repository}" \
 && ./install-tl --no-interaction --scheme=infraonly --no-doc-install --no-src-install --verify-downloads \
      --texdir=/usr/local/texlive --location="${repository}" 2>&1 | tee /tmp/install-tl.out \
 && grep -q "^Installing TeX Live ${TL_YEAR} from: .* (verified)$" /tmp/install-tl.out \
 && platform_dir="$(echo /usr/local/texlive/bin/*)" \
 && ln -s "${platform_dir}" /usr/local/texlive/bin/default \
 && { echo latex-bin; sed -e 's/#.*//' /tmp/packages.txt; } \
      | xargs /usr/local/texlive/bin/default/tlmgr --repository "${repository}" install 2>&1 | tee /tmp/tlmgr.out \
 && grep -q "^tlmgr: package repository .* (verified)$" /tmp/tlmgr.out \
 && rm -rf /usr/local/texlive/tlpkg/backups /usr/local/texlive/texmf-var/web2c/*/*.log \
      /usr/local/texlive/install-tl.log /tmp/install-tl /tmp/*.out /tmp/packages.txt


FROM ${PYTHON_IMAGE}

LABEL org.opencontainers.image.title="cv-tools" \
      org.opencontainers.image.description="Generate a LaTeX CV from a YAML file" \
      org.opencontainers.image.source="https://github.com/mlsdpk/cv-tools" \
      org.opencontainers.image.licenses="MIT"

COPY --from=texlive /usr/local/texlive /usr/local/texlive

# TEXMFVAR is writable for any user id (docker run --user).
ENV PATH=/usr/local/texlive/bin/default:${PATH} \
    TEXMFVAR=/tmp/texmf-var \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

COPY docker/constraints.txt /tmp/constraints.txt
COPY pyproject.toml README.md LICENSE /tmp/cv-tools/
COPY src /tmp/cv-tools/src

# Since pip 26.2, PIP_CONSTRAINT no longer reaches the isolated build, so
# PIP_BUILD_CONSTRAINT pins the build backend.
RUN PIP_CONSTRAINT=/tmp/constraints.txt PIP_BUILD_CONSTRAINT=/tmp/constraints.txt pip install /tmp/cv-tools \
 && rm -rf /tmp/cv-tools /tmp/constraints.txt \
 && cv-tools doctor \
 && cv-tools init /tmp/smoke \
 && cv-tools build /tmp/smoke/cv.yaml -o /tmp/smoke/cv.pdf \
 && rm -rf /tmp/smoke /tmp/texmf-var

WORKDIR /work
ENTRYPOINT ["cv-tools"]
CMD ["--help"]
