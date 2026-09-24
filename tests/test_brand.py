"""Brand drift and migration checks for current public surfaces, not historic data."""
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / 'brand.json').read_text())
module_spec = importlib.util.spec_from_file_location('sync_brand', ROOT / 'scripts/sync_brand.py')
brand = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(brand)


class Surface(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.ids = []
        self.styles = []
        self.style_depth = 0
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        for name in ('href', 'src'):
            if name in attrs:
                self.links.append(attrs[name])
        if tag == 'style':
            self.style_depth += 1
        if 'style' in attrs:
            self.styles.append(attrs['style'])

    def handle_endtag(self, tag):
        if tag == 'style':
            self.style_depth -= 1

    def handle_data(self, data):
        if self.style_depth:
            self.styles.append(data)


class BrandTests(unittest.TestCase):
    def test_generated_surfaces_are_current(self):
        for path, expected in brand.generated_files().items():
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertTrue(path.is_file(), 'Run scripts/sync_brand.py')
                self.assertEqual(path.read_text(), expected, 'Run scripts/sync_brand.py')

    def test_current_public_naming_and_claims(self):
        paths = list(ROOT.rglob('*.html')) + [ROOT/'llms.txt', ROOT/'barcode/barcode.js']
        for path in paths:
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertNotRegex(path.read_text(), re.compile(r'\bopentag one\b|make the best localization practical|with open hardware', re.I))
        self.assertIn(SPEC['mission'], (ROOT/'index.html').read_text())
        self.assertIn(SPEC['mission'], (ROOT/'llms.txt').read_text())

    def test_development_products_have_status_and_no_purchase_action(self):
        for product in SPEC['products']:
            if product['id'] != 'U1':
                self.assertEqual(product['status'], 'Coming Soon')
                self.assertNotIn('action', product)
                self.assertNotIn('url', product)
        for rel in ('index.html', 'products/index.html', 'branding/index.html'):
            text = (ROOT/rel).read_text()
            for product in SPEC['products']:
                card = re.search(r'<article[^>]*data-product="' + product['id'] + r'">(.*?)</article>', text, re.S)
                self.assertIsNotNone(card, (rel, product['id']))
                self.assertIn(product['status'], card[1])
                if product['id'] != 'U1':
                    self.assertNotIn('<a ', card[1])

    def test_new_marketing_styles_use_shared_tokens(self):
        # Instrument panels and print labels have functional palettes. Keep this
        # allowlist narrow: new marketing pages/styles are checked by default.
        exempt = {'assets/brand.css', 'firmware/tdoa.css', 'barcode/index.html'}
        for path in list(ROOT.rglob('*.css')) + list(ROOT.rglob('*.html')):
            if path.relative_to(ROOT).as_posix() in exempt:
                continue
            css = path.read_text() if path.suffix == '.css' else '\n'.join(Surface(path.read_text()).styles)
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertNotRegex(css, r'#[0-9a-fA-F]{3,8}\b', 'Use --brand-* color tokens')
                self.assertNotRegex(css, r'border-radius:\s*4px', 'Use --brand-radius')
        for path in ROOT.rglob('*.html'):
            text = path.read_text()
            if path != ROOT/'one/index.html':
                self.assertIn('data-site-header', text, str(path))
                self.assertIn('/assets/brand.css', text, str(path))
        self.assertNotIn('header.innerHTML', (ROOT/'assets/site.js').read_text())

    def test_all_page_links_and_fragments_resolve(self):
        redirects = {'/one/': '/products/u1/', '/start/': '/docs/quickstart/'}
        for page in ROOT.rglob('*.html'):
            parsed = Surface(page.read_text())
            self.assertEqual(len(parsed.ids), len(set(parsed.ids)), f'Duplicate IDs: {page}')
            for link in parsed.links:
                url = urlsplit(link)
                if url.scheme or url.netloc:
                    continue
                route = unquote(url.path)
                route = redirects.get(route, route)
                target = ROOT / route.lstrip('/') if route.startswith('/') else page.parent / route if route else page
                if target.is_dir():
                    target /= 'index.html'
                with self.subTest(page=page.relative_to(ROOT), link=link):
                    self.assertTrue(target.is_file(), str(target))
                    if url.fragment and target.suffix == '.html':
                        fragment = unquote(url.fragment)
                        if target == ROOT/'firmware/index.html' and fragment in ('distance', 'location'):
                            fragment += '-mode'
                        self.assertIn(fragment, Surface(target.read_text()).ids)

    def test_legacy_redirects_preserve_query_and_fragment(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node required for executable redirect checks; CI installs Node')
        source = (ROOT/'assets/legacy-redirect.js').read_text()
        cases = [('/one/', '?utm_source=old', '#kits', '/products/u1/?utm_source=old#kits'),
                 ('/one', '', '#resources', '/products/u1/#resources'),
                 ('/one/index.html', '?x=1', '', '/products/u1/?x=1'),
                 ('/one/', '?next=https://example.com', '#resources', '/products/u1/?next=https://example.com#resources'),
                 ('/start/', '?x=1', '#calibrate', '/docs/quickstart/?x=1#calibrate'),
                 ('/products/u1/', '', '', None)]
        js = 'const vm = require("node:vm"); const assert = require("node:assert/strict");\n'
        js += 'const source = ' + json.dumps(source) + ';\n'
        js += 'const cases = ' + json.dumps(cases) + ';\n'
        js += '''for (const [pathname, search, hash, expected] of cases) {
          let actual = null;
          vm.runInNewContext(source, {window: {location: {pathname, search, hash, replace(value) {actual = value;}}}});
          assert.equal(actual, expected);
        }'''
        result = subprocess.run([node, '-e', js], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for old, new in [('one', '/products/u1/'), ('start', '/docs/quickstart/')]:
            text = (ROOT/old/'index.html').read_text()
            self.assertIn('/assets/legacy-redirect.js', text)
            self.assertIn(f'url={new}', text)
            self.assertIn(f'href="{new}"', text)
        for anchor in ('kits', 'resources'):
            self.assertIn(anchor, Surface((ROOT/'products/u1/index.html').read_text()).ids)

    def test_deployment_contains_new_and_legacy_pages_only_public_roots(self):
        workflow = (ROOT/'.github/workflows/pages.yaml').read_text()
        copied = re.search(r'cp -R (.+) _site/', workflow)[1].split()
        for name in ('products', 'one', 'start', 'branding', 'assets'):
            self.assertIn(name, copied)
        self.assertNotIn('business', copied)
        self.assertNotIn('.', copied)
        self.assertIn('sync_brand.py --check', workflow)
        self.assertFalse((ROOT/'business').exists())


if __name__ == '__main__':
    unittest.main()
