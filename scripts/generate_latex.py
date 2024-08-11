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

import yaml
from jinja2 import Environment, FileSystemLoader
import argparse
import os

def load_config(config_path):
    """Load YAML configuration file."""
    with open(config_path) as file:
        return yaml.safe_load(file)

def render_template(template_dir, template_file, config):
    """Render the Jinja2 template with the configuration data."""
    env = Environment(loader=FileSystemLoader(template_dir))
    template = env.get_template(template_file)
    return template.render(config)

def save_output(output_path, output_data):
    """Save the rendered output to a file."""
    with open(output_path, 'w') as file:
        file.write(output_data)

def main():
    # Set up argument parser
    parser = argparse.ArgumentParser(description="Generate LaTeX CV from a config file using Jinja2 template.")
    parser.add_argument('config', type=str, help="Path to the YAML configuration file.")
    parser.add_argument('template', type=str, help="Path to the Jinja2 template file.")
    parser.add_argument('output', type=str, help="Path to save the generated LaTeX file.")
    
    args = parser.parse_args()
    
    # Extract directory and file names
    template_dir, template_file = os.path.split(args.template)
    
    # Load config, render template, and save output
    config = load_config(args.config)
    output_data = render_template(template_dir, template_file, config)
    save_output(args.output, output_data)

if __name__ == "__main__":
    main()
