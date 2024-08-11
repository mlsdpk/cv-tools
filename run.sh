#!/bin/bash
#
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

# Get the directory of the script
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Set the paths based on the script's location
CONFIG_FILE="$CURRENT_DIR/config/cv.yaml"
TEMPLATE_DIR="$CURRENT_DIR/template"
LATEX_TEMPLATE_FILE="$TEMPLATE_DIR/template.tex.jinja"
SCRIPT_DIR="$CURRENT_DIR/scripts"
OUTPUT_DIR="$CURRENT_DIR/output"
OUTPUT_FILE="$OUTPUT_DIR/output.tex"

echo "CONFIG_FILE: $CONFIG_FILE"
echo "TEMPLATE_DIR: $TEMPLATE_DIR"
echo "LATEX_TEMPLATE_FILE: $LATEX_TEMPLATE_FILE"
echo "OUTPUT_DIR: $OUTPUT_DIR"
echo "OUTPUT_FILE: $OUTPUT_FILE"

# Create the output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

# Copy the resume.cls file to the output directory
cp "$TEMPLATE_DIR/resume.cls" "$OUTPUT_DIR/"

# Run the Python script with the generated paths
echo "python "$SCRIPT_DIR/generate_latex.py" "$CONFIG_FILE" "$LATEX_TEMPLATE_FILE" "$OUTPUT_FILE""
python "$SCRIPT_DIR/generate_latex.py" "$CONFIG_FILE" "$LATEX_TEMPLATE_FILE" "$OUTPUT_FILE"

# Notify the user that the script has completed
echo "Latex cv generation complete. Output saved to $OUTPUT_FILE"

# compile the latex
cd $OUTPUT_DIR && pdflatex -interaction=nonstopmode $OUTPUT_FILE

exit 0