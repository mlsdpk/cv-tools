%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% Medium Length Professional CV - RESUME CLASS FILE
%
% This template has been downloaded from:
% http://www.LaTeXTemplates.com
%
% This class file defines the structure and design of the template. 
%
% Original header:
% Copyright (C) 2010 by Trey Hunner
%
% Copying and distribution of this file, with or without modification,
% are permitted in any medium without royalty provided the copyright
% notice and this notice are preserved. This file is offered as-is,
% without any warranty.
%
% Created by Trey Hunner and modified by www.LaTeXTemplates.com
%
%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

\ProvidesClass{resume}[2010/07/10 v0.9 Resume class]

\LoadClass[11pt,letterpaper]{article} % Font size and paper type

\usepackage[parfill]{parskip} % Remove paragraph indentation
\usepackage{array} % Required for boldface (\bf and \bfseries) tabular columns
\usepackage{ifthen} % Required for ifthenelse statements
\usepackage{fontawesome}
\usepackage{xcolor}
\usepackage{graphicx}

\newcommand{\colorfaLinkedinSquare}{\textcolor{rgb:red,6;green,108;blue,170}{\raisebox{-0.7pt}{\faLinkedinSquare}}}
\newcommand{\colorfaGithub}{\textcolor{black}{\raisebox{-1.3pt}{\large\faGithub}}}
\newcommand{\colorfaTwitter}{\textcolor{rgb:red,29;green,161;blue,242}{\raisebox{-1.5pt}{\large\faTwitter}}}

\pagestyle{empty} % Suppress page numbers

%----------------------------------------------------------------------------------------
%	HEADINGS COMMANDS: Commands for printing name and address
%----------------------------------------------------------------------------------------

\def \name#1{\def\@name{#1}} % Defines the \name command to set name
\def \@name {} % Sets \@name to empty by default

\def \addressSep {$|$} % Set default address separator to a diamond

% One, two or three address lines can be specified 
\let \@addressone \relax
\let \@addresstwo \relax
\let \@addressthree \relax

% \address command can be used to set the first, second, and third address (last 2 optional)
\def \address #1{
  \@ifundefined{@addresstwo}{
    \def \@addresstwo {#1}
  }{
  \@ifundefined{@addressthree}{
  \def \@addressthree {#1}
  }{
     \def \@addressone {#1}
  }}
}

% \printaddress is used to style an address line (given as input)
\def \printaddress #1{
  \begingroup
    \def \\ {\addressSep\ }
    \centerline{#1}
  \endgroup
  \par
  \addressskip
}

% \printname is used to print the name as a page header
\def \printname {
  \begingroup
    \hfil{\MakeUppercase{\namesize\bf \@name}}\hfil
    \nameskip\break
  \endgroup
}

%----------------------------------------------------------------------------------------
%	PRINT THE HEADING LINES
%----------------------------------------------------------------------------------------

\let\ori@document=\document
\renewcommand{\document}{
  \ori@document  % Begin document
  \printname % Print the name specified with \name
  \@ifundefined{@addressone}{}{ % Print the first address if specified
    \printaddress{\@addressone}}
  \@ifundefined{@addresstwo}{}{ % Print the second address if specified
    \printaddress{\@addresstwo}}
     \@ifundefined{@addressthree}{}{ % Print the third address if specified
    \printaddress{\@addressthree}}
}

%----------------------------------------------------------------------------------------
%	SECTION FORMATTING
%----------------------------------------------------------------------------------------

% Defines the rSection environment for the large sections within the CV
\newenvironment{rSection}[1]{ % 1 input argument - section name
  \sectionskip
  \MakeUppercase{\bf #1} % Section title
  \sectionlineskip
  \hrule % Horizontal line
  \begin{list}{}{ % List for each individual item in the section
    \setlength{\leftmargin}{1.5em} % Margin within the section
  }
  \item[]
}{
  \end{list}
}

%----------------------------------------------------------------------------------------
%	WORK EXPERIENCE FORMATTING
%----------------------------------------------------------------------------------------

\newenvironment{rSubsection}[5]{ % 4 input arguments - company name, year(s) employed, job title and location
 {#1} \hfill {\em #2} % Bold company name and date on the right
 \ifthenelse{\equal{#3}{}}{}{ % If the third argument is not specified, don't print the job title and location line
  \\
  {#3} \hfill {#4} % Italic job title and location
   \ifthenelse{\equal{#5}{}}{}{
   \\
   {#5}
   }
  }\smallskip
  \begin{list}{\textbullet}{\leftmargin=1em} % \cdot used for bullets, no indentation
    \setlength{\itemsep}{-0.5em} \vspace{-0.5em} % Reduce vertical spacing between items in the list for a tighter look
  }{
  \end{list}
  \vspace{0.5em} % Some space after the list of bullet points
}

% The below commands define the whitespace after certain things in the document - they can be \smallskip, \medskip or \bigskip
\def\namesize{\huge} % Size of the name at the top of the document
\def\addressskip{\smallskip} % The space between the two address (or phone/email) lines
\def\sectionlineskip{\medskip} % The space above the horizontal line for each section 
\def\nameskip{\bigskip} % The space after your name at the top
\def\sectionskip{\medskip} % The space after the heading section

\usepackage{enumitem}
\usepackage{hyperref}
\hypersetup{
    colorlinks=true,
    linkcolor=blue,
    filecolor=magenta,      
    urlcolor=blue
    }
% \MakeUppercase prints the name and the section titles. It must not change
% link targets, so the URL argument of \href and the argument of \url keep
% their case (LaTeX 2022 and later; older releases have no such list).
\ExplSyntaxOn
\tl_if_exist:NT \l_text_case_exclude_arg_tl
  { \tl_put_right:Nn \l_text_case_exclude_arg_tl { \href \url } }
\ExplSyntaxOff

% The ORCID iD logo. cv-tools 1.x drew it with TikZ and sized it with
% \scalerel*{<drawing>}{|}. The same arithmetic (calc's \ratio and \resizebox)
% on an empty box of the drawing's natural size (256pt square, no depth) gives
% the same box at every font size. orcid.pdf is then drawn once at that size;
% it has a 1pt margin on each side, which trim removes.
\usepackage{calc}
\newlength\orcid@blob
\newlength\orcid@depth
\newlength\orcid@wd
\newlength\orcid@ht
\newcommand\orcid@logo{%
  \setbox0\hbox{$|$}%
  \setlength\orcid@blob{\ht0+\dp0}%
  \setlength\orcid@depth{\dp0}%
  \setbox0\hbox{\vrule width\z@ height256pt depth\z@ \kern256pt}%
  \setlength\orcid@wd{\wd0*\ratio{\orcid@blob}{\ht0}}%
  \setlength\orcid@ht{\ht0*\ratio{\orcid@blob}{\ht0}}%
  \setbox0\hbox{\resizebox{\orcid@wd}{\orcid@ht}{\box0}}%
  \setbox2\hbox{\includegraphics[trim=1pt 1pt 1pt 1pt,width=\wd0,height=\ht0]{orcid.pdf}}%
  \wd2=\wd0 \ht2=\ht0 \dp2=\z@
  \raisebox{-\orcid@depth}{\box2}}
\newcommand\orcidicon[1]{\href{https://orcid.org/#1}{\mbox{\orcid@logo}}}

% Greek letters and math symbols in text and .bib fields, as math. Only
% characters that LaTeX's own UTF-8 declarations (ot1enc, t1enc, ts1enc and
% omsenc.dfu) leave out are declared here; tools/derive_unicode.py checks that.
\DeclareUnicodeCharacter{03B1}{\ensuremath{\alpha}}% α
\DeclareUnicodeCharacter{03B2}{\ensuremath{\beta}}% β
\DeclareUnicodeCharacter{03B3}{\ensuremath{\gamma}}% γ
\DeclareUnicodeCharacter{03B4}{\ensuremath{\delta}}% δ
\DeclareUnicodeCharacter{03B5}{\ensuremath{\varepsilon}}% ε
\DeclareUnicodeCharacter{03B6}{\ensuremath{\zeta}}% ζ
\DeclareUnicodeCharacter{03B7}{\ensuremath{\eta}}% η
\DeclareUnicodeCharacter{03B8}{\ensuremath{\theta}}% θ
\DeclareUnicodeCharacter{03B9}{\ensuremath{\iota}}% ι
\DeclareUnicodeCharacter{03BA}{\ensuremath{\kappa}}% κ
\DeclareUnicodeCharacter{03BB}{\ensuremath{\lambda}}% λ
\DeclareUnicodeCharacter{03BC}{\ensuremath{\mu}}% μ
\DeclareUnicodeCharacter{03BD}{\ensuremath{\nu}}% ν
\DeclareUnicodeCharacter{03BE}{\ensuremath{\xi}}% ξ
\DeclareUnicodeCharacter{03BF}{\ensuremath{o}}% ο
\DeclareUnicodeCharacter{03C0}{\ensuremath{\pi}}% π
\DeclareUnicodeCharacter{03C1}{\ensuremath{\rho}}% ρ
\DeclareUnicodeCharacter{03C2}{\ensuremath{\varsigma}}% ς
\DeclareUnicodeCharacter{03C3}{\ensuremath{\sigma}}% σ
\DeclareUnicodeCharacter{03C4}{\ensuremath{\tau}}% τ
\DeclareUnicodeCharacter{03C5}{\ensuremath{\upsilon}}% υ
\DeclareUnicodeCharacter{03C6}{\ensuremath{\varphi}}% φ
\DeclareUnicodeCharacter{03C7}{\ensuremath{\chi}}% χ
\DeclareUnicodeCharacter{03C8}{\ensuremath{\psi}}% ψ
\DeclareUnicodeCharacter{03C9}{\ensuremath{\omega}}% ω
\DeclareUnicodeCharacter{03D1}{\ensuremath{\vartheta}}% ϑ
\DeclareUnicodeCharacter{03D5}{\ensuremath{\phi}}% ϕ
\DeclareUnicodeCharacter{03D6}{\ensuremath{\varpi}}% ϖ
\DeclareUnicodeCharacter{03F1}{\ensuremath{\varrho}}% ϱ
\DeclareUnicodeCharacter{03F5}{\ensuremath{\epsilon}}% ϵ
\DeclareUnicodeCharacter{0391}{\ensuremath{\mathrm{A}}}% Α
\DeclareUnicodeCharacter{0392}{\ensuremath{\mathrm{B}}}% Β
\DeclareUnicodeCharacter{0393}{\ensuremath{\Gamma}}% Γ
\DeclareUnicodeCharacter{0394}{\ensuremath{\Delta}}% Δ
\DeclareUnicodeCharacter{0395}{\ensuremath{\mathrm{E}}}% Ε
\DeclareUnicodeCharacter{0396}{\ensuremath{\mathrm{Z}}}% Ζ
\DeclareUnicodeCharacter{0397}{\ensuremath{\mathrm{H}}}% Η
\DeclareUnicodeCharacter{0398}{\ensuremath{\Theta}}% Θ
\DeclareUnicodeCharacter{0399}{\ensuremath{\mathrm{I}}}% Ι
\DeclareUnicodeCharacter{039A}{\ensuremath{\mathrm{K}}}% Κ
\DeclareUnicodeCharacter{039B}{\ensuremath{\Lambda}}% Λ
\DeclareUnicodeCharacter{039C}{\ensuremath{\mathrm{M}}}% Μ
\DeclareUnicodeCharacter{039D}{\ensuremath{\mathrm{N}}}% Ν
\DeclareUnicodeCharacter{039E}{\ensuremath{\Xi}}% Ξ
\DeclareUnicodeCharacter{039F}{\ensuremath{\mathrm{O}}}% Ο
\DeclareUnicodeCharacter{03A0}{\ensuremath{\Pi}}% Π
\DeclareUnicodeCharacter{03A1}{\ensuremath{\mathrm{P}}}% Ρ
\DeclareUnicodeCharacter{03A3}{\ensuremath{\Sigma}}% Σ
\DeclareUnicodeCharacter{03A4}{\ensuremath{\mathrm{T}}}% Τ
\DeclareUnicodeCharacter{03A5}{\ensuremath{\Upsilon}}% Υ
\DeclareUnicodeCharacter{03A6}{\ensuremath{\Phi}}% Φ
\DeclareUnicodeCharacter{03A7}{\ensuremath{\mathrm{X}}}% Χ
\DeclareUnicodeCharacter{03A8}{\ensuremath{\Psi}}% Ψ
\DeclareUnicodeCharacter{03A9}{\ensuremath{\Omega}}% Ω
\DeclareUnicodeCharacter{2264}{\ensuremath{\leq}}% ≤
\DeclareUnicodeCharacter{2265}{\ensuremath{\geq}}% ≥
\DeclareUnicodeCharacter{2260}{\ensuremath{\neq}}% ≠
\DeclareUnicodeCharacter{2248}{\ensuremath{\approx}}% ≈
\DeclareUnicodeCharacter{223C}{\ensuremath{\sim}}% ∼
\DeclareUnicodeCharacter{2194}{\ensuremath{\leftrightarrow}}% ↔
\DeclareUnicodeCharacter{21D2}{\ensuremath{\Rightarrow}}% ⇒
\DeclareUnicodeCharacter{221E}{\ensuremath{\infty}}% ∞
\DeclareUnicodeCharacter{2208}{\ensuremath{\in}}% ∈
\DeclareUnicodeCharacter{2209}{\ensuremath{\notin}}% ∉
\DeclareUnicodeCharacter{2282}{\ensuremath{\subset}}% ⊂
\DeclareUnicodeCharacter{2211}{\ensuremath{\sum}}% ∑
\DeclareUnicodeCharacter{220F}{\ensuremath{\prod}}% ∏
\DeclareUnicodeCharacter{221A}{\ensuremath{\surd}}% √
\DeclareUnicodeCharacter{2202}{\ensuremath{\partial}}% ∂
\DeclareUnicodeCharacter{2207}{\ensuremath{\nabla}}% ∇

\usepackage[nodayofweek]{datetime}

% Redefine the date format
\newdateformat{customdate}{%
\ordinal{DAY} \monthname[\THEMONTH] \THEYEAR}

\usepackage[left=0.55in,top=0.6in,right=0.55in,bottom=0.6in]{geometry} % Document margins
\newcommand{\tab}[1]{\hspace{.2667\textwidth}\rlap{#1}}
\newcommand{\itab}[1]{\hspace{0em}\rlap{#1}}