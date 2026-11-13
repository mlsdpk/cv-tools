#!/usr/bin/env bash

# MIT License
#
# Copyright (c) 2024 Phone Thiha Kyaw
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

# Deprecated wrapper around 'cv-tools build', removed in a future release.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    echo "Usage: $0 [-c config_file] [-o output_file] [--tex-only] [--no-deps]"
    echo "  -c, --config   the CV YAML file (default: config/cv.yaml; examples/cv.yaml without config/)"
    echo "  -o, --output   the output LaTeX file (default: output/output.tex)"
    echo "  --tex-only     only write the LaTeX files, without producing a PDF"
    echo "  --no-deps      skip the dependency checks and call pdflatex directly"
    echo "  -h, --help     show this help message and exit"
    echo
    echo "run.sh is deprecated. Use 'cv-tools build' instead (see 'cv-tools build --help')."
}

error() {
    echo "run.sh: error: $1" >&2
}

CONFIG_FILE=""
OUTPUT_FILE="$ROOT/output/output.tex"
TEX_ONLY=0
NO_DEPS=0

while [ $# -gt 0 ]; do
    case "$1" in
        -c | --config | -o | --output )
            if [ $# -lt 2 ]; then
                error "option $1 needs a value"
                usage >&2
                exit 1
            fi
            case "$1" in
                -c | --config ) CONFIG_FILE="$2" ;;
                * ) OUTPUT_FILE="$2" ;;
            esac
            shift
            ;;
        --tex-only )
            TEX_ONLY=1
            ;;
        --no-deps )
            NO_DEPS=1
            ;;
        -h | --help )
            usage
            exit 0
            ;;
        * )
            error "invalid option $1"
            usage >&2
            exit 1
            ;;
    esac
    shift
done

echo "run.sh is deprecated and will be removed in a future release. Use 'cv-tools build' instead." >&2

if [ -z "$CONFIG_FILE" ]; then
    if [ ! -d "$ROOT/config" ]; then
        CONFIG_FILE="$ROOT/examples/cv.yaml"
    elif [ -f "$ROOT/config/cv.yaml" ]; then
        CONFIG_FILE="$ROOT/config/cv.yaml"
    else
        error "$ROOT/config/cv.yaml does not exist"
        example="$ROOT/config/<file>.yaml"
        found=0
        for candidate in "$ROOT"/config/*.yaml "$ROOT"/config/*.yml; do
            if [ -f "$candidate" ]; then
                if [ "$found" -eq 0 ]; then
                    echo "YAML files in $ROOT/config:" >&2
                    example="$candidate"
                fi
                found=1
                echo "  $candidate" >&2
            fi
        done
        if [ "$found" -eq 0 ]; then
            echo "$ROOT/config has no YAML files." >&2
        fi
        echo "Choose the CV file with -c, for example: $0 -c $example" >&2
        exit 1
    fi
fi
echo "run.sh: building $CONFIG_FILE" >&2

new_enough() {
    "$1" -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1
}

python_version() {
    "$1" -c 'import platform; print(platform.python_version())' 2>/dev/null
}

in_environment() {
    "$1" -c 'import os, sys; sys.exit(not (sys.prefix != sys.base_prefix or os.path.isdir(os.path.join(sys.prefix, "conda-meta"))))' >/dev/null 2>&1
}

too_old() {
    version="$(python_version "$1")"
    if [ -z "$version" ]; then
        echo "$2 cannot be run as Python"
    else
        echo "$2 is $version"
    fi
}

if [ -n "${CV_TOOLS_PYTHON:-}" ]; then
    PY="$CV_TOOLS_PYTHON"
    if ! new_enough "$PY"; then
        error "Python 3.10 or newer is required ($(too_old "$PY" "CV_TOOLS_PYTHON=$PY"))"
        exit 1
    fi
else
    PY=""
    TOO_OLD=""
    CANDIDATES=()
    if [ -n "${VIRTUAL_ENV:-}" ]; then
        CANDIDATES+=("$VIRTUAL_ENV/bin/python")
    fi
    if [ -n "${CONDA_PREFIX:-}" ]; then
        CANDIDATES+=("$CONDA_PREFIX/bin/python")
    fi
    CANDIDATES+=("$ROOT/.venv/bin/python" python3 python3.14 python3.13 python3.12 python3.11 python3.10)
    for candidate in "${CANDIDATES[@]}"; do
        if ! command -v "$candidate" >/dev/null 2>&1; then
            continue
        fi
        if new_enough "$candidate"; then
            PY="$candidate"
            break
        fi
        TOO_OLD="${TOO_OLD:-$candidate}"
    done
    if [ -z "$PY" ]; then
        if [ -n "$TOO_OLD" ]; then
            error "Python 3.10 or newer is required ($(too_old "$TOO_OLD" "$TOO_OLD")); set CV_TOOLS_PYTHON to a newer Python"
        else
            error "Python 3.10 or newer is required, but no python3 was found; set CV_TOOLS_PYTHON to one"
        fi
        exit 1
    fi
fi

export PYTHONPATH="$ROOT/src${PYTHONPATH:+:$PYTHONPATH}"

ARGS=(build "$CONFIG_FILE" -o "$OUTPUT_FILE")
if [ "$TEX_ONLY" -eq 1 ]; then
    ARGS+=(--tex-only)
fi

if "$PY" -c 'import cv_tools.cli' >/dev/null 2>&1; then
    :
elif [ "$NO_DEPS" -eq 1 ]; then
    problem="$("$PY" -c 'import cv_tools.cli' 2>&1 | tail -n 1)"
    error "$PY cannot import cv-tools (${problem:-unknown error}); run without --no-deps to install its dependencies"
    exit 1
else
    if ! in_environment "$PY"; then
        # PEP 668: never pip-install into a system Python.
        if [ -e "$ROOT/.venv" ]; then
            error "$ROOT/.venv exists but has no usable Python 3.10 or newer; remove it or set CV_TOOLS_PYTHON"
            exit 1
        fi
        echo "run.sh: creating a virtual environment in $ROOT/.venv with $PY" >&2
        if ! "$PY" -m venv "$ROOT/.venv"; then
            error "$PY could not create $ROOT/.venv (on Debian and Ubuntu, install python3-venv)"
            exit 1
        fi
        PY="$ROOT/.venv/bin/python"
    fi
    echo "run.sh: installing cv-tools and its dependencies with pip into the environment of $PY" >&2
    if ! "$PY" -m pip install "$ROOT"; then
        error "pip could not install cv-tools and its dependencies"
        exit 1
    fi
fi

if [ "$NO_DEPS" -eq 1 ]; then
    ARGS+=(--engine pdflatex)
else
    ARGS+=(--engine auto)
fi

exec "$PY" -m cv_tools "${ARGS[@]}"
