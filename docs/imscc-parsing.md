# IMSCC Parsing: What Gets Indexed, and Why

This records how an uploaded Canvas course export (`.imscc`) is turned into
documents in the tutor's knowledge base, and — more importantly — what is
deliberately left out.

The rules live in [`worker/src/classify.js`](../worker/src/classify.js) and are
applied by [`worker/src/extract.js`](../worker/src/extract.js). This document
explains the reasoning; the code is the authority on the detail.

## The requirement

Only **teaching material** may reach the tutor. Quizzes, exams, assignments,
question banks and any other evaluation must never be indexed, because the tutor
answers student questions and must not be able to recite an assessment or its
answers. Course packaging metadata is excluded too, because it is noise that
degrades retrieval without informing anybody.

## What an IMSCC actually contains

A cartridge is a ZIP with an `imsmanifest.xml` at its root. The manifest lists
every file as a `<resource>` carrying a `type` attribute, and that attribute is
the authoritative statement of what a file *is*. It is stable across cartridge
versions 1.1 through 1.3.

| Resource type | What it is |
| --- | --- |
| `webcontent` | Pages and uploaded files — general web content |
| `imsqti_xmlv1p2/imscc_xmlv1pN/assessment` | Quiz or exam |
| `imsqti_xmlv1p2/imscc_xmlv1pN/question-bank` | Question bank |
| `assignment_xmlv1p0` | Assignment |
| `associatedcontent/imscc_xmlv1p1/learning-application-resource` | Canvas catch-all: assignment settings, rubrics, course settings, attachments |
| `imsdt_xmlv1p1` / `1p2` / `1p3` | Discussion topic |
| `imswl_xmlv1p1` / `1p2` / `1p3` | External web link |
| `imsbasiclti_xmlv1p0` / `_xmlv1p3` | LTI tool launch |

Canvas also uses conventional folders: `wiki_content/` (Pages),
`web_resources/` (uploaded files), `course_settings/` (course metadata),
`assignment_settings/`, and `non_cc_assessments/` (Canvas quizzes), plus
per-assessment `assessment_qti.xml` and `assessment_meta.xml` files.

## The rule: two gates, both must pass

### Gate 1 — resource type allowlist

Only `webcontent` is treated as teaching material. **Every other type is
excluded, including types this code has never seen.**

This is an allowlist rather than a denylist, and that is the single most
important decision recorded here. The failure modes are not symmetrical:

- A denylist that misses a new type **leaks an exam to students**.
- An allowlist that misses a new type **drops a page**, visibly, in the
  exclusion counts, and is recoverable by adding the type.

So when a future Canvas release introduces a new quiz format, this code drops it
rather than publishing it.

Gate 1 alone excludes quizzes, question banks, assignments, discussions, web
links and LTI links.

### Gate 2 — path exclusions

Canvas writes some of its own bookkeeping as plain `webcontent`, so type alone
is not enough. Excluded by path:

- `course_settings/**` — course metadata (**except `syllabus.html`**, see below)
- `assignment_settings/**` — assignment metadata
- `non_cc_assessments/**` — Canvas quizzes
- `assessment_qti.xml`, `assessment_meta.xml` — assessment bodies and metadata
- `files_meta.xml`, `module_meta.xml`, `rubrics.xml`, `canvas_export.txt` and
  the other named Canvas settings files

The folder rules matter independently of the filename list: a settings file this
code has never heard of is still excluded because of where it sits.

### Gate 3 — readable text

The pre-existing extension filter (`.htm`, `.html`, `.md`, `.txt`, `.xml`) still
applies. This gate is about whether a file **can be read**, not about whether it
**belongs**. Keeping the two separate is deliberate: conflating them is exactly
how assignments came to be indexed in the first place — `assignment_settings/*.xml`
is readable text, so an extension-only filter admitted it.

## Decisions and their reasoning

### The syllabus is included

`syllabus.html` is kept even though Canvas files it under `course_settings/`.

It is the page students ask about most ("what is the late policy?"), it is
genuine course information, and it contains no questions and no answers. The
risk being guarded against is leaking assessment content; a syllabus carries
none, even though it describes how grading works.

### Discussion topics are excluded

A Canvas discussion may be **graded**, in which case it is an evaluation — but
the discussion resource itself does not say so. Determining it requires
cross-referencing assignment metadata, and when that resolution is inconclusive
the failure is the one that must not happen: an evaluation gets indexed.

Canvas also exports **announcements** as discussion topics, so the type mixes
teaching prompts, graded work and administrative notices.

Excluding the whole type is the fail-closed choice. The cost is ungraded
discussion prompts, which are the lowest-value teaching content in a typical
export; the substance lives in pages and files.

### Uploaded files are included

Everything in `web_resources/` that is `webcontent` is indexed. These are the
professor's own lecture notes and handouts — prime teaching material.

**Filename keyword filtering was considered and deliberately rejected.**
Excluding files matching `exam`, `answer`, `solution` and similar would look
like a safety control while providing almost none: it misses
`bio101-w7-worked.html`, it fires on a legitimate page titled "How to answer
free-response questions", and — worst — it creates false confidence that
evaluations are being screened when they are not.

## The limitation, stated plainly

**Structural filtering guarantees that everything Canvas *classified* as an
assessment is excluded. It cannot detect an evaluation that a professor filed as
a page or an upload.**

A Canvas Page named "Exam 1 Answers" is, structurally, a page. It will be
indexed. No arrangement of these rules changes that, because the cartridge
contains no signal to distinguish it.

If that residual risk needs a control, the control belongs outside the parser —
in a professor-facing review of what was indexed — not in more parsing
heuristics.

## Reporting

Nothing is dropped silently. The completion manifest carries:

```json
"excludedCounts": {
  "assessment or evaluation content": 4,
  "course metadata rather than teaching material": 2,
  "not a readable text member": 8
},
"excludedSamples": [
  { "path": "assignment_settings/lab-02.xml", "resourceType": "...", "reason": "..." }
]
```

Counts are always complete. Samples are capped at 20, because a course may
reference up to 5000 members and the manifest must not grow without bound.

Before this existed, excluded files were dropped with a bare `continue` and no
record at all — which is why nobody noticed that every assignment in every
imported course was being indexed.

A package that is well-formed but yields no teaching content (a course of
nothing but quizzes) fails validation with a message that says so, rather than
reporting the generic "no text content" error.

## Testing

- [`worker/test/classify.test.js`](../worker/test/classify.test.js) asserts the
  verdict for the full table of real cartridge resource types, written out in
  full rather than generated, because the guarantee rests on matching them
  exactly. It includes unknown types, to prove the allowlist fails closed.
- [`worker/test/extract.test.js`](../worker/test/extract.test.js) asserts against
  a real cartridge that no assignment is ever indexed and that the syllabus and
  weekly pages survive.

Both suites have been mutation-verified: admitting Canvas assignments, turning
the allowlist into a denylist, removing the syllabus exception, removing the
`course_settings/` folder rule, and disabling exclusion reporting each fail a
specific test, while a comment-only control change leaves the suite green.

## Known gap

The legacy synchronous importer (`ui/api/imscc.js`, reached via
`POST /api/imscc-import`) has its own parsing and does **not** apply these rules.
It is scheduled for removal in the Phase 5 cutover. Until then, content imported
through that path is not filtered.
