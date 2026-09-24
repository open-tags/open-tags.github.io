# opentags brand guidelines

<!-- Generated from brand.json. Run python3 scripts/sync_brand.py. -->

## Mission

Make accurate tracking accessible to people building robots.

**Public headline:** Accurate tracking. Built for robotics.

We build tracking hardware and integration tools to help robot developers measure position and motion.

## Principles

- **Simple by default.** Make setup, calibration, and integration understandable. Explain the complete system a developer needs, including its cost and limitations.
- **Clear about capabilities.** Support accuracy claims with measurements and stated test conditions. Distinguish measured results, development targets, and planned capabilities. Name the resources actually available.

## Product family

| Name | Description | Status |
| --- | --- | --- |
| opentag U1 | UWB ranging and localization |  |
| opentag U2 | UWB with inertial measurements | Coming Soon |
| opentag L1 | LoRa sensing research hardware | Coming Soon |
| opentag S1 | Shared synchronization hardware | Coming Soon |

## Naming

- Write the company as opentags: lowercase, plural, one word. Use open-tags only in existing URLs and account names.
- Use singular opentag for product names, with uppercase family letters and generation numbers: opentag U1, U2, L1, S1. Pair short names with a useful descriptor.
- Name packages U1 Distance Kit and U1 Location Kit. Keep PCB revision numbers separate from product generations.
- Preserve historical identifiers, firmware commands, asset filenames, and published data. Redirect retired page URLs and retain section links.

## Voice and evidence

- Lead with tracking for robotics. Explain UWB and LoRa within the relevant product, rather than defining the whole company by a radio technology.
- Use concrete language and useful details. Avoid unsupported superlatives and vague claims of precision.
- Describe measured performance with its setup, conditions, and limitations on the relevant product and performance pages. Label goals as targets and future features as planned.
- Use Coming Soon beside each upcoming product. Omit status labels for available products. Keep product cards concise: name, descriptor, description, and Coming Soon where applicable, without extra caveats beneath the card or product grid. Do not offer a purchase action for an unreleased product.
- Describe public resources individually. Do not promise that all hardware or firmware is open source. Hardware design files are not currently published; this is not a declaration of future licensing policy.

## Typography

- Use Editorial New for major marketing headlines and short titles over product photography.
- Use system sans for navigation, body text, section headings, labels, controls, and specifications.
- Monospace is allowed for code, logs, commands, and identifiers when it improves readability.

## Color and interface

- Use the shared monochrome palette for branding. Reuse the shared CSS tokens for fonts, color, spacing, content width, and four-pixel control corners.
- Use thin borders and generous spacing. Let the hardware and measured evidence carry the page.
- Functional colors are allowed for warnings, errors, success, and measurement series. Pair color with labels, shapes, or other cues; never communicate status through color alone.
- Dark instrument panels, circular data markers, and technical diagrams are functional exceptions. Review keyboard focus, contrast, and mobile layout.

## Imagery

- Show real hardware, connections, and use contexts. Clearly label illustrations and simulated data.
- Keep image titles short and readable. Use a subtle neutral gradient where a title overlays photography.
- Identify the pictured product correctly. Do not present U1 photographs as images of U2, L1, or S1.

## Maintenance

- Edit brand.json, then run python3 scripts/sync_brand.py. BRAND.md, shared tokens, navigation, the brand-page content, and product listings are generated from that specification.
- Run python3 scripts/sync_brand.py --check and python3 -B -m unittest discover -s tests -v before publication.
- Review current public prose and metadata for naming and claims. Historical records, third-party code, technical identifiers, and private business notes are outside copy-renaming scope.
- Keep private business notes, contacts, and correspondence out of this public repository and its deployment artifact.

## Design tokens

| Token | Value |
| --- | --- |
| `--brand-ink` | `#111111` |
| `--brand-paper` | `#ffffff` |
| `--brand-muted` | `#666666` |
| `--brand-soft` | `#f7f7f7` |
| `--brand-line` | `#dddddd` |
| `--brand-line-strong` | `#c4c4c4` |
| `--brand-hover` | `#303030` |
| `--brand-disabled` | `#868686` |
| `--brand-error` | `#b00020` |
| `--brand-warning` | `#9b5500` |
| `--brand-success` | `#247a3d` |
| `--brand-font-body` | `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` |
| `--brand-font-editorial` | `"Editorial New", "Iowan Old Style", Georgia, serif` |
| `--brand-font-code` | `ui-monospace, SFMono-Regular, Consolas, monospace` |
| `--brand-radius` | `4px` |
| `--brand-content-width` | `1120px` |
| `--brand-gutter` | `20px` |
| `--brand-space-sm` | `16px` |
| `--brand-space-md` | `32px` |
| `--brand-space-lg` | `64px` |
