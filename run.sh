#!/bin/bash

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

# Function to print the usage
usage() {
    info "Usage: $0 [-c config_file] [-b bibtex_file] [-o output_file]"
    info "  -c, --config   Specify the configuration YAML file (default: config/cv.yaml)"
    info "  -b, --bibtex   Specify the BibTeX file (default: config/publications.bib)"
    info "  --no-deps      Skip checking and installing dependencies"
    info "  -o, --output   Specify the output LaTeX file (default: output/output.tex)"
    info "  -h, --help     Display this help message and exit"
    exit 1
}

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check and install if a LaTeX package is not found
check_latex_package() {
    local package="$1"
    PACKAGE_INFO=$(tlmgr info "$package" 2>/dev/null)
    
    if echo "$PACKAGE_INFO" | grep -q -E "installed:\s*Yes"; then
        success "LaTeX package $package is already installed."
    else
        error "LaTeX package $package is not installed."
        info "Attempting to install $package..."

        # Run the installation
        tlmgr install "$package"
        if [ $? -eq 0 ]; then
            success "LaTeX package $package has been installed."
        else
            error "Failed to install LaTeX package $package."
            exit 1
        fi
    fi
}

# Function to check and install LaTeX packages from a file
check_latex_packages_from_file() {
    local package_file="$1"
    while IFS= read -r package || [ -n "$package" ]; do
        package=$(echo "$package" | xargs)  # Trim any surrounding whitespace
        if [ -n "$package" ]; then
            check_latex_package "$package"
        fi
    done < "$package_file"
}

info() {
    echo -e "\033[1;34m[INFO]\033[0m $1"
}

success() {
    echo -e "\033[1;32m[SUCCESS]\033[0m $1"
}

error() {
    echo -e "\033[1;31m[ERROR]\033[0m $1" >&2
}

# Get the directory of the script
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default file paths
CONFIG_DIR="$CURRENT_DIR/config"
CONFIG_FILE="$CONFIG_DIR/cv.yaml"
BIBTEX_FILE="$CONFIG_DIR/publications.bib"
TEMPLATE_DIR="$CURRENT_DIR/template"
LATEX_TEMPLATE_FILE="$TEMPLATE_DIR/template.tex.jinja"
SCRIPT_DIR="$CURRENT_DIR/scripts"
OUTPUT_DIR="$CURRENT_DIR/output"
OUTPUT_FILE="$OUTPUT_DIR/output.tex"

# Default value for skipping dependency installation
SKIP_DEPS_INSTALL=0

# Parse command-line options
while [[ "$1" != "" ]]; do
    case $1 in
        -c | --config )
            shift
            CONFIG_FILE="$1"
            ;;
        -b | --bibtex )
            shift
            BIBTEX_FILE="$1"
            ;;
        --no-deps )
            SKIP_DEPS_INSTALL=1
            ;;
        -o | --output )
            shift
            OUTPUT_FILE="$1"
            OUTPUT_DIR="$(dirname "$OUTPUT_FILE")"
            ;;
        -h | --help )
            usage
            ;;
        * )
            error "Invalid option $1"
            usage
            ;;
    esac
    shift
done

# Start of the script
info "Intializing the script..."

# If --no-deps-install is not set, check dependencies
if [ "$SKIP_DEPS_INSTALL" -eq 0 ]; then

    info "Verifying required libraries and dependencies..."

    # Check if LaTeX is installed
    if command_exists pdflatex; then
        success "pdflatex found."
    else
        error "Error: command pdflatex not found." 
        error "LaTeX is not installed. Please install LaTeX (e.g., TeX Live) to proceed."
        info "If you are on Ubuntu, you can install it using:"
        info "  sudo apt-get install texlive-latex-base"    
        exit 1
    fi

    # Check if Python is installed
    if ! command_exists python; then
        error "Error: python is not installed. Please install python to proceed."
        exit 1
    fi

    # Check if Python version is 3.x
    PYTHON_VERSION=$(python -c 'import sys; version=sys.version_info[:3]; print("{0}.{1}".format(*version))')
    if [[ ! $PYTHON_VERSION =~ ^3\.[0-9]+$ ]]; then
        error "Error: python version 3.x is required. Detected python version: $PYTHON_VERSION"
        exit 1
    fi

    # Output Python version and location
    PYTHON_PATH=$(command -v python)
    success "python found. Using python version $PYTHON_VERSION from $PYTHON_PATH"

    # Check and install required Python packages from requirements.txt
    info "Checking for required Python packages..."
    if [ -f "requirements.txt" ]; then
        pip install -r requirements.txt
        if [ $? -eq 0 ]; then
            success "All required Python packages have been installed."
        else
            error "Failed to install required Python packages."
            exit 1
        fi
    else
        error "requirements.txt file not found."
        exit 1
    fi

    # Read and install required LaTeX packages
    LATEX_PACKAGE_FILE="$CURRENT_DIR/packages.list"
    if [ -f "$LATEX_PACKAGE_FILE" ]; then
        info "Verifying required LaTeX packages..."
        check_latex_packages_from_file "$LATEX_PACKAGE_FILE"
    else
        error "LaTeX package file not found: $LATEX_PACKAGE_FILE"
        exit 1
    fi

    # Notify the user that all dependencies are satisfied
    success "All required libraries and dependencies have been verified and installed."
else
    info "Skipping dependency checks and installations."
fi

# Create the output directory if it doesn't exist
info "Creating output directory..."
mkdir -p "$OUTPUT_DIR"

# Copy the resume.cls file to the output directory
info "Copying resume.cls to output directory..."
cp "$TEMPLATE_DIR/resume.cls" "$OUTPUT_DIR/"

# Run the Python script with the provided or default paths
info "Generating LaTeX file..."
python "$SCRIPT_DIR/generate_latex.py" "$CONFIG_FILE" "$LATEX_TEMPLATE_FILE" "$OUTPUT_FILE" --bibtex "$BIBTEX_FILE"

if [ $? -eq 0 ]; then
        success "OK."
    else
        error "Failed"
        exit 1
fi

# Notify the user that LaTeX generation is complete
success "LaTeX CV generation complete. Output saved to $OUTPUT_FILE"

# Compile the LaTeX file to PDF
info "Compiling LaTeX to PDF..."
cd "$OUTPUT_DIR" && pdflatex "$(basename "$OUTPUT_FILE")"

if [ $? -eq 0 ]; then
    success "PDF generation complete. Output saved to ${OUTPUT_FILE%.tex}.pdf"
else
    error "Error during PDF compilation."
    exit 1
fi

exit 0
