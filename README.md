<!-- markdownlint-disable-next-line -->
<div align="center">

  <!-- markdownlint-disable-next-line -->
  # CV Tools

  A tool to automate the creation of professional LaTeX-based CVs.

  ![LaTeX](https://img.shields.io/badge/latex-%23008080.svg?style=for-the-badge&logo=latex&logoColor=white)
  ![Jinja](https://img.shields.io/badge/jinja-white.svg?style=for-the-badge&logo=jinja&logoColor=black)
  ![Python](https://img.shields.io/badge/python-3670A0?style=for-the-badge&logo=python&logoColor=ffdd54)

  ![cover photo](docs/img/cover.png)
</div>

CV Tools is a project designed to streamline the creation of academic CVs using LaTeX. This project provides templates and configuration files to easily generate an academic CV with customizable sections for education, work experience, publications, and more.

Feel free to edit and use this project according to your needs. Customize the LaTeX templates and configuration files to fit your personal requirements and preferences.

An example CV created using this tool can be found [here](https://www.phonethk.com/assets/docs/cv.pdf).

# Features
- **Customizable LaTeX Templates**: Pre-defined LaTeX templates for creating professional CVs.
- **Flexible Configuration**: Easy-to-edit configuration files to personalize your CV.
- **BibTeX Support**: Automatically generate a formatted list of publications from a BibTeX file.
- **Automated Build Process**: Scripted build process to generate the final PDF CV.

# Table of Contents
- [Getting Started](#getting-started)
    - [Installation](#installation)
    - [Usage](#usage)
- [YAML Configuration](#yaml-configuration)
- [BibTeX Configuration](#bibtex-configuration)
- [Contributing](#contributing)

# Getting Started

Below are two installation methods to set up and use CV Tools on your local machine. The Docker-based setup is recommended for a hassle-free experience, but you can also set up manually from the source if you prefer.

## Installation

### Method 1: Using Docker (Recommended)

> [!WARNING]  
> Coming soon.

#### Prerequisites
- **Docker**: Ensure you have Docker installed on your machine. You can download and install Docker from [here](https://docs.docker.com/engine/install/).

### Method 2: From Source with Manual Installation

If you prefer to set up the environment manually on your local machine, follow the steps below.

#### Prerequisites
- **LaTeX Distribution**: Ensure you have a LaTeX distribution installed. For instance, [TeX Live](https://www.tug.org/texlive/) (recommended) or [MikTeX](https://miktex.org/).
- **Python**: Python 3.x is required for running the build scripts.

#### Installing Dependencies

Make sure the necessary LaTeX packages are installed:
```bash
$ tlmgr install fontawesome xcolor geometry datetime2 scalerel academicons
```

To manage your Python dependencies, it's recommended to use a virtual environment:
```bash
$ python3 -m venv cv-tools
$ source cv-tools/bin/activate
```

Install the required Python packages using requirements.txt:
```bash
$ pip install -r requirements.txt
```

Clone the Repository:
```bash
$ git clone https://github.com/mlsdpk/cv-tools.git
$ cd cv-tools
```

## Usage
To generate the default CV, you can run the provided shell script. This script will use the sample `cv.yaml` and `publications.bib` files located in the config directory.
```bash
$ ./run.sh 
```
This command will create a PDF file of the CV using the default configuration. The generated `.tex` file and the resulting PDF file will be located in the `output` directory.

You can customize the content of your CV by editing the `cv.yaml` file in the `config` directory. This file allows you to define your personal details, education, work experience, skills, and more. You can add or remove sections, modify the fields, and tailor the CV content to your specific needs. The supported section types include `education`, `experience`, `skills`, `bullets`, `talks`, and `publications`. For more information, refer to [YAML Configuration](#yaml-configuration) section.

This tool also supports to automatically list your publications based on BibTeX entries provided in this BibTeX file. Refer to [BibTeX Configuration](#bibtex-configuration) section for more details on configuring BibTeX entries.

# YAML Configuration

## General Information

| Key            | Description                                      |
|----------------|--------------------------------------------------|
| `author_name`  | The full name of the author.                     |
| `portfolio_url`| URL to the author's online portfolio.            |
| `orcid_id`     | ORCID ID for unique identification.              |
| `linkedin`     | LinkedIn profile URL.                            |
| `email`        | Email address of the author.                     |

## Supported Section Types

### 1. Education

| Key            | Description                                       |
|----------------|---------------------------------------------------|
| `type`         | Must be `education`.                              |
| `content`      | List of education entries.                        |

**Education Entry**

| Key             | Description                                              |
|-----------------|----------------------------------------------------------|
| `university`    | Name of the university or institution.                  |
| `location`      | Location of the university or institution.              |
| `dates`         | Duration of study.                                     |
| `degree`        | Degree obtained.                                        |
| `honors`        | Honors received (optional).                            |
| `thesis_title`  | Title of the thesis or dissertation (optional).        |
| `supervisor`    | Name of the thesis supervisor (optional).              |

Example:
```yaml
- type: education
  content:
    - university: "Fictional University"
      location: "Imaginaria, Wonderland"
      dates: "September 2021 - June 2024"
      degree: "Bachelor of Science in Computer Science"
      honors: "Magna Cum Laude"
      thesis_title: "An Exploration of Quantum Computing in Virtual Environments"
      supervisor: "Dr. Alice Wonder"
    - university: "Imaginary Institute of Technology"
      location: "Nowhere City, Utopia"
      dates: "August 2018 - May 2021"
      degree: "Associate Degree in Artificial Intelligence"
      supervisor: "Dr. Bob Builder"
```

### 2. Experience

| Key            | Description                                       |
|----------------|---------------------------------------------------|
| `type`         | Must be `experience`.                             |
| `content`      | List of experience entries.                       |

**Experience Entry**

| Key            | Description                                              |
|----------------|----------------------------------------------------------|
| `name`         | Title of the experience section (e.g., "Professional Experience"). |
| `entity`       | List of experience entities.                           |

**Experience Entity**

| Key              | Description                                              |
|------------------|----------------------------------------------------------|
| `organization`   | Name of the organization or company.                    |
| `dates`          | Duration of employment or involvement.                  |
| `position`       | Position or role held.                                  |
| `responsibilities` | List of responsibilities or achievements.             |
| `supervisor`     | Supervisor's name (optional).                           |
| `department`     | Department name (optional).                             |
| `location`      | Location of the organization (optional).               |

Example:
```yaml
- type: experience
  content:
    - name: "Professional Experience"
      entity:
        - organization: "Tech Innovations Inc."
          dates: "July 2024 - Present"
          position: "Software Engineer"
          responsibilities:
            - "Developed and maintained cloud-based solutions for various enterprise clients."
            - "Led a team of developers in designing scalable software architectures."
            - "Improved system performance by 30% through code optimization and database restructuring."
        - organization: "NextGen Robotics"
          dates: "June 2022 - June 2024"
          position: "Robotics Engineer"
          responsibilities:
            - "Designed and implemented autonomous navigation systems for industrial robots."
            - "Collaborated with cross-functional teams to integrate machine learning models into robotic platforms."
```

### 3. Bullets

| Key            | Description                                       |
|----------------|---------------------------------------------------|
| `type`         | Must be `bullets`.                                |
| `title`        | Title of the bullet section.                      |
| `description`  | Description or introductory text (optional).      |
| `content`      | List of bullet points.                            |

**Bullet Item**

| Key         | Description                                              |
|-------------|----------------------------------------------------------|
| `item`      | Main bullet point text.                                  |
| `subitems`  | List of sub-bullet points under the main item (optional).|

Example:
```yaml
- type: bullets
  title: "Honors and Awards"
  description: ""
  content:
    - item: "Dean's List (2023, 2022)"
    - item: "Best Paper Award at Tech Innovations Conference (2023)"
    - item: "Outstanding Graduate Award, Fictional University (2024)"

- type: bullets
  title: "Professional Activities"
  description: "Served/ing as a reviewer for"
  content:
    - item: "Journals"
      subitems:
        - "Journal of Artificial Intelligence Research (JAIR)"
        - "Journal of Machine Learning Research (JMLR)"
    - item: "Conferences"
      subitems:
        - "IEEE Conference on Computer Vision and Pattern Recognition (CVPR)"
        - "International Conference on Learning Representations (ICLR)"
```

### 4. Skills

| Key            | Description                                       |
|----------------|---------------------------------------------------|
| `type`         | Must be `skills`.                                 |
| `content`      | List of skills.                                   |

**Skills Entry**

| Key            | Description                                       |
|----------------|---------------------------------------------------|
| `name`         | Title of the skills category.                     |
| `data`         | List of skills or technologies.                   |

Example:
```yaml
- type: skills
  content:
    - name: "Spoken Languages"
      data: "English (Fluent), Spanish (Intermediate)"
    - name: "Programming Languages"
      data: "Python, Java, C++, SQL, JavaScript"
    - name: "Tools and Technologies"
      data: "AWS, Docker, Kubernetes, TensorFlow, Git, Jenkins, Linux, Jira"
```

### 5. Talks

| Key            | Description                                       |
|----------------|---------------------------------------------------|
| `type`         | Must be `talks`.                                  |
| `content`      | List of talks or presentations.                   |

**Talk Entry**

| Key            | Description                                       |
|----------------|---------------------------------------------------|
| `name`         | Title of the talk, type, conference or event name, location. |
| `month`        | Month of the talk.                               |
| `year`         | Year of the talk.                                |

Example:
```yaml
- type: talks
  content:
    - name: "``AI in Everyday Life'', Invited talk, Tech Conference 2023, Imaginaria."
      month: "Nov."
      year: "2023"
    - name: "``Cloud Computing for Beginners'', Workshop, FutureTech Expo 2022, Nowhere City."
      month: "Oct."
      year: "2022"
    - name: "``Robotics in Modern Industry'', Guest lecture, Imaginary Institute of Technology."
      month: "May"
      year: "2021"
    - name: "``Building Scalable Systems with Docker and Kubernetes'', Workshop, DevOps World 2023, Tech City."
      month: "Aug."
      year: "2023"
    - name: "``Ethics in AI'', Panel discussion, Ethics in Technology Conference 2022, Metropolis."
      month: "Sep."
      year: "2022"
```

An example of a complete YAML configuration can be found [here](config/cv.yaml).

# BibTeX Configuration

Managing your publications is straightforward with a BibTeX file. The BibTeX file allows you to maintain a structured list of your publications, which can be automatically formatted and included in your CV.

## Steps to Configure BibTeX:
1. Ensure you have a `publications.bib` file in the config directory with your publication details.
2. Add your BibTeX entries directly into this file, and they will be automatically formatted and included in your CV.

**Example BibTeX Entry:**
```bibtex
@article{doe2024quantum,
  author = {John Doe and Jane Smith and Alice Wonder},
  title = {Quantum Computing: Bridging the Gap Between Theory and Application},
  journal = {Journal of Computer Science},
  year = {2024},
  url = {https://example.com/quantum-computing-paper}
}
```
Your publications will be included in the CV in the order they appear in the .bib file. An example BibTeX data file is provided [here](config/publications.bib).

# Contributing
Feel free to contribute to this project by submitting issues or pull requests. Contributions are welcome to improve the templates, add new features, or fix bugs.

# Acknowledgments
The LaTeX template currently supported in this project is based on the **Medium Length Professional CV** template from [LaTeXTemplates.com](https://www.latextemplates.com/template/medium-length-professional-cv), which has been extensively modified for this project. The original template was created by [Trey Hunner](https://treyhunner.com).

# License
This project is licensed under the [MIT License](https://opensource.org/license/mit).
