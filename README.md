CV Tools
========

CV Tools is a project designed to streamline the creation of academic CVs using LaTeX. This project provides templates and configuration files to easily generate an academic CV with customizable sections for education, work experience, publications, and more.

Feel free to edit and use this project according to your needs. Customize the LaTeX templates and configuration files to fit your personal requirements and preferences.

An example CV created using this tool can be found [here](https://www.phonethk.com/assets/docs/cv.pdf).

# Features
- **Customizable LaTeX Templates**: Pre-defined LaTeX templates for creating professional CVs.
- **Flexible Configuration**: Easy-to-edit configuration files to personalize your CV.
- **Automated Build Process**: Scripted build process to generate the final PDF CV.

# Getting Started

Follow these instructions to set up and use CV Tools on your local machine.

## Prerequisites
- **LaTeX Distribution**: Ensure you have a LaTeX distribution installed. For instance, TeX Live or MikTeX.
- **Python**: Python 3.x is required for running the build scripts.

## Installation
### 1. Clone the Repository:
```bash
git clone https://github.com/yourusername/cv-tools.git
cd cv-tools
```

### 2. Install Dependencies:
Ensure you have the required LaTeX packages installed:
```bash
tlmgr install fontawesome xcolor geometry datetime2 scalerel academicons
```

Install python dependencies using the provided `requirements.txt` file:
```bash
pip install -r requirements.txt
```

## Usage

### 1. YAML Configuration
Edit the cv.yaml file in the config directory to include your personal details, education, work experience, and publications etc.

### 2. Run
Use the provided script to generate your CV:
```
./run.sh
```
This script creates a directory called `output` and the generated `.tex` file and the resulting PDF will be saved under that directory.

# Contributing
Feel free to contribute to this project by submitting issues or pull requests. Contributions are welcome to improve the templates, add new features, or fix bugs.

# License
This project is licensed under the [MIT License](https://opensource.org/license/mit).