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

import re
import yaml
from jinja2 import Environment, FileSystemLoader
from pybtex.database import parse_file
import argparse
import os
import sys

def load_config(config_path):
    """Load YAML configuration file."""
    with open(config_path) as file:
        return yaml.safe_load(file)
    
def format_name(person):
    """Format the name by combining first, middle, and last names."""
    first_names = ' '.join(person.first_names) if person.first_names else ''
    middle_names = ' '.join(person.middle_names) if person.middle_names else ''
    last_names = ' '.join(person.last_names) if person.last_names else ''
    
    full_name = f"{first_names} {middle_names} {last_names}".strip()
    return full_name

def load_bibtex(bibtex_path):
    """Load BibTeX file and extract publication data."""
    bib_data = parse_file(bibtex_path)
    publications = []
    
    for entry in bib_data.entries.values():
        authors_list = []
        for person in entry.persons['author']:
            full_name = format_name(person)
            authors_list.append(full_name)
        authors = ', '.join(authors_list)

        # format the authors
        def format_authors(authors_list):
            """Format the authors list with commas and 'and' before the last author."""
            if len(authors_list) > 1:
                return ', '.join(authors_list[:-1]) + ' and ' + authors_list[-1]
            elif authors_list:
                return authors_list[0]
            return ''
        
        authors = format_authors(authors_list)

        publications.append({
            'authors': authors,
            'title': entry.fields['title'],
            'venue': entry.fields.get('journal', entry.fields.get('booktitle', '')),
            'year': entry.fields['year'],
            'link': entry.fields.get('url', '')
        })
    
    return publications

def decode_special_characters(text):
    # Convert bold (**text**) to LaTeX \textbf{text}
    text = re.sub(r'\*\*(.*?)\*\*', r'\\textbf{\1}', text)

    # Convert italics (*text*) to LaTeX \textit{text}
    text = re.sub(r'\*(.*?)\*', r'\\textit{\1}', text)

    # Convert markdown links [text](url) to LaTeX \href{url}{text}
    text = re.sub(r'\[(.*?)\]\((.*?)\)', r'\\href{\2}{\1}', text)

    # Convert newline characters (\n) to LaTeX \\ for line breaks
    text = text.replace('\n', '\\\\')

    # Convert horizontal spacing
    text = re.sub(r' {4}', r'\\quad ', text)   # Replace 4 spaces with \quad
    text = re.sub(r'\t', r'\\quad ', text)     # Replace tab with \quad
    text = re.sub(r' {2}', r'\\ ', text)       # Replace 2 spaces with a small space in LaTeX

    # Add more conversions if needed

    return text

def transform_configs(data):
    if isinstance(data, dict):
        return {k: transform_configs(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [transform_configs(item) for item in data]
    elif isinstance(data, str):
        return decode_special_characters(data) 
    return data

def render_template(template_dir, template_file, config):
    """Render the Jinja2 template with the configuration data."""
    env = Environment(loader=FileSystemLoader(template_dir))

    # Register all the filters here if needed
    # env.filters['markdown_to_latex'] = markdown_to_latex

    # apply transformation to all the yaml configs
    config = transform_configs(config)

    # render the final template
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
    parser.add_argument('--bibtex', type=str, help="Path to the BibTeX file for publications.", default=None)
    
    args = parser.parse_args()
    
    # Extract directory and file names
    template_dir, template_file = os.path.split(args.template)
    
    # Load config
    config = load_config(args.config)

    # publications handling
    # Check if "publications" type is given
    publications_found = any(_type["type"] == "publications" for _type in config['sections'])
    if publications_found:
        # If BibTeX file is provided, load it and update the config
        if args.bibtex:
                config['publications'] = load_bibtex(args.bibtex)
        else:
            sys.exit("Error: section 'publications' found in the config but BibTeX file not provided.")
    
    # render template, and save output
    output_data = render_template(template_dir, template_file, config)
    save_output(args.output, output_data)

if __name__ == "__main__":
    main()
