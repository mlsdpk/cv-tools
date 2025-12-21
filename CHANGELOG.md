# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Two new entries in `publications` section type
    - `title` for specifying custom section name for publications
    - `bibfile` for specifying a path to BibTex file

### Changed
- Update readme to support new way of specifying a bibtex file
- Section type `publications` is now part of sections list in jinja template
- Modify publications handling logic in `generate_latex.py`
    - now support one or more publication sections
    - add support for `title` and `bibfile` fields

### Deprecated

### Removed
- No longer supports specifying bibtex file through the script options

### Fixed
- Fix issue where social links are not rendered correctly

<br>

## Released

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
