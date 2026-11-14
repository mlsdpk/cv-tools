# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-11-13

### Added
- Web app to edit your CV in the browser with a live preview
- `cv-tools` command with `build`, `watch`, `init`, `validate`, `migrate` and `doctor`
- Generic section layouts, including a new `text` layout
- JSON Schema for autocompletion in editors
- Greek letters and common math symbols

### Changed
- New YAML format with the same keys in every layout
- Smaller Docker image that runs `cv-tools` directly
- LaTeX special characters such as `%` and `&` no longer need escaping

### Deprecated
- The v1 YAML format and `run.sh`, to be removed in a future release

### Removed
- Raw `\tikz` and `\scalerel` commands

### Fixed
- Author names keep "van" and "Jr." parts
- Missing publication fields no longer print ", ," or stop the build
- Empty values no longer print "None"
- Duplicate YAML keys are reported instead of silently replaced

<br>

## Released

### [1.1.0] - 2025-12-21

#### Added
- Two new entries in `publications` section type
    - `title` for specifying custom section name for publications
    - `bibfile` for specifying a path to BibTex file

#### Changed
- Update readme to support new way of specifying a bibtex file
- Section type `publications` is now part of sections list in jinja template
- Modify publications handling logic in `generate_latex.py`
    - now support one or more publication sections
    - add support for `title` and `bibfile` fields
- Migrate to latex-action GitHub action for building LaTeX documents

#### Removed
- No longer supports specifying bibtex file through the script options

#### Fixed
- Remove extra space from orcidurl

### [1.0.0] - 2025-06-20

#### Added
- Add `--tex-only` option to run.sh command to optionally allow users to only generate a tex file
- Bold the author name in publications if it matches with heading name
- Add `title` field to talks section (breaking change, old version users need to add this field to show the title for this section)
- Add decoding of 'quoted text' to LaTeX-style quotes ``quoted text''

#### Changed
- Update README to support `--tex-only` option
- Update README to include quotes subsection under special characters

#### Fixed
- Run shell as default if no arguments are given upon docker run (https://github.com/mlsdpk/cv-tools/pull/1)
