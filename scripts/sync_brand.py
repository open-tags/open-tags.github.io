#!/usr/bin/env python3
"""Generate public brand documentation, tokens, product listings, and navigation."""
import argparse
import html
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / 'brand.json'


def esc(value):
    return html.escape(value, quote=True)


def header(spec, route):
    links = []
    for item in spec['navigation']:
        active = any(route.startswith(prefix) for prefix in item['prefixes'])
        current = ' aria-current="page"' if active else ''
        links.append(f'<a{current} href="{esc(item["url"])}">{esc(item["label"])}</a>')
    return '''<header class="site-header" data-site-header>
      <a class="brand" href="/" aria-label="opentags home">opentags</a>
      <button class="nav-toggle" type="button" data-nav-toggle aria-label="Open menu" aria-expanded="false"><span class="nav-toggle-icon" aria-hidden="true"></span></button>
      <nav aria-label="Primary">''' + ''.join(links) + '''</nav>
    </header>'''


def footer():
    return '''<footer class="site-footer"><div class="footer-row"><span>&copy; 2026 opentags</span><nav aria-label="Footer"><a href="/branding/">Brand</a><a href="https://github.com/open-tags" rel="noreferrer">GitHub</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="mailto:hello@open-tags.com">Contact</a></nav></div></footer>'''


def product_cards(spec, heading=3):
    cards = []
    for product in spec['products']:
        action = (f'<a class="one-text-link" href="{esc(product["url"])}">{esc(product["action"])} →</a>'
                  if product.get('url') else '')
        status = (f'<p class="product-status">{esc(product["status"])}</p>'
                  if product.get("status") else "")
        cards.append(f'''<article class="product-card" data-product="{esc(product['id'])}">
          {status}
          <h{heading}>{esc(product['name'])}</h{heading}>
          <p class="product-descriptor">{esc(product['descriptor'])}</p>
          <p>{esc(product['description'])}</p>
          {action}
        </article>''')
    return '\n'.join(line.rstrip() for line in ('<div class="product-grid">\n' + '\n'.join(cards) + '\n</div>').splitlines())


def brand_content(spec):
    parts = [f'''<section class="brand-intro">
        <div><p class="brand-kicker">Brand guidelines</p><h1>Accurate tracking.<br />A clear identity.</h1></div>
        <p>opentags should feel precise, direct, and easy to work with. Our identity makes room for a family of tracking products.</p>
      </section>
      <section class="brand-section">
        <div class="brand-heading"><p class="brand-kicker">Mission</p><h2>{esc(spec['mission'])}</h2></div>
        <div class="voice-sample"><strong>{esc(spec['headline'])}</strong><p>{esc(spec['description'])}</p></div>
      </section>''']
    principles = ''.join(f'<article class="brand-card"><span class="number">0{i}</span><h3>{esc(p["title"])}</h3><p>{esc(p["text"])}</p></article>' for i, p in enumerate(spec['principles'], 1))
    parts.append('<section class="brand-section"><div class="brand-heading"><p class="brand-kicker">Principles</p><h2>Useful. Understandable. Measured.</h2></div><div class="principle-grid">' + principles + '</div></section>')
    parts.append('<section class="brand-section"><div class="brand-heading"><p class="brand-kicker">Products</p><h2>One company. A family of products.</h2></div>' + product_cards(spec) + '</section>')
    for title, rules in spec['rules'].items():
        # Engineering maintenance lives in BRAND.md, not the public marketing page.
        if title == 'Maintenance':
            continue
        items = ''.join(f'<li>{esc(rule)}</li>' for rule in rules)
        parts.append(f'<section class="brand-section"><div class="brand-heading"><p class="brand-kicker">Guidelines</p><h2>{esc(title)}</h2></div><ul class="brand-rules">{items}</ul>')
        if title == 'Typography':
            parts.append('<div class="type-grid"><article class="type-card"><span class="label">Editorial New</span><div class="editorial-specimen">Built for robotics.</div></article><article class="type-card"><span class="label">System sans</span><div class="sans-specimen">From setup to useful measurements.</div><p>Code example: <code>ros2 topic echo /opentags/range</code></p></article></div>')
        if title == 'Color and interface':
            swatches = ''.join(f'<article class="swatch"><div class="swatch-color" style="background:var(--brand-{key})"></div><div class="swatch-meta"><strong>{esc(key.title())}</strong><span>{esc(spec["tokens"][key].upper())}</span></div></article>' for key in ['ink', 'paper', 'muted', 'soft', 'line'])
            parts.append('<div class="swatches">' + swatches + '</div>')
        if title == 'Imagery':
            parts.append('<figure class="image-example"><img src="/assets/images/one/site/hero.jpg" alt="Two opentag U1 devices measuring distance" width="1920" height="960" loading="lazy" decoding="async" /><figcaption>opentag U1</figcaption></figure>')
        parts.append('</section>')
    return '\n'.join(parts)


def markdown(spec):
    lines = ['# opentags brand guidelines', '', '<!-- Generated from brand.json. Run python3 scripts/sync_brand.py. -->', '', '## Mission', '', spec['mission'], '', '**Public headline:** ' + spec['headline'], '', spec['description'], '', '## Principles', '']
    for p in spec['principles']:
        lines.append(f'- **{p["title"]}** {p["text"]}')
    lines += ['', '## Product family', '', '| Name | Description | Status |', '| --- | --- | --- |']
    for p in spec['products']:
        lines.append(f'| {p["name"]} | {p["descriptor"]} | {p["status"]} |')
    for title, rules in spec['rules'].items():
        lines += ['', '## ' + title, ''] + ['- ' + rule for rule in rules]
    lines += ['', '## Design tokens', '', '| Token | Value |', '| --- | --- |']
    lines += [f'| `--brand-{k}` | `{v}` |' for k, v in spec['tokens'].items()]
    return '\n'.join(lines) + '\n'


def generated_files(root=ROOT):
    spec = json.loads((root / 'brand.json').read_text())
    outputs = {root / 'BRAND.md': markdown(spec)}
    css = '/* Generated from brand.json. Run python3 scripts/sync_brand.py. */\n:root {\n'
    css += ''.join(f'  --brand-{key}: {value};\n' for key, value in spec['tokens'].items()) + '}\n'
    outputs[root / 'assets/brand.css'] = css
    for path in sorted(root.rglob('*.html')):
        if any(part.startswith('.') for part in path.relative_to(root).parts):
            continue
        text = path.read_text()
        route = '/' + path.parent.relative_to(root).as_posix().strip('.') + '/'
        route = route.replace('//', '/')
        text = re.sub(r'<header\b[^>]*data-site-header[^>]*>.*?</header>', lambda _: header(spec, route), text, flags=re.S)
        text = re.sub(r'<footer class="site-footer">.*?</footer>', lambda _: footer(), text, flags=re.S)
        if path == root / 'branding/index.html':
            text = re.sub(r'<main>.*?</main>', lambda _: '<main>\n' + brand_content(spec) + '\n    </main>', text, flags=re.S)
        if '<!-- brand:products:start -->' in text:
            text = re.sub(r'<!-- brand:products:start -->.*?<!-- brand:products:end -->', lambda _: '<!-- brand:products:start -->\n' + product_cards(spec, heading=2 if path == root / 'products/index.html' else 3) + '\n<!-- brand:products:end -->', text, flags=re.S)
        outputs[path] = text
    return outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if generated content is stale; do not write.')
    args = parser.parse_args()
    stale = []
    for path, expected in generated_files().items():
        actual = path.read_text() if path.exists() else None
        if actual != expected:
            stale.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.write_text(expected)
    if stale:
        print(('Out of date: ' if args.check else 'Updated: ') + ', '.join(stale))
    else:
        print('Brand documentation, tokens, product listings, and navigation are current.')
    return 1 if args.check and stale else 0


if __name__ == '__main__':
    raise SystemExit(main())
