# Website changes

Read BRAND.md before changing public copy or design. Its source is brand.json.
Edit the specification, then run `python3 scripts/sync_brand.py`; do not hand-edit
generated brand sections, BRAND.md, navigation, or assets/brand.css.

Use shared tokens and existing components. Label development capabilities and
cite measurement conditions rather than implying validated tracking performance.
Keep private business notes, contacts, and correspondence outside this repository.

Preserve legacy URLs, query strings, fragments, downloads, firmware commands,
and technical identifiers. Do not bulk-rename asset files or historical data.

Before finishing, run `python3 scripts/sync_brand.py --check` and relevant tests.
For visual changes, inspect desktop and mobile layouts and keyboard navigation.
The automated rules supplement human review; they do not validate accuracy claims.

Commit and deployment are separate actions; do not publish merely to preview.
