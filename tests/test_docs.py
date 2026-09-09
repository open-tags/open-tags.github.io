"""Source-level documentation checks; no browser or hardware access."""

import ast
import re
import subprocess
import unittest
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PAGES = sorted((ROOT / "docs").rglob("index.html"))


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.links = []
        self.nav = []
        self.current = []
        self.in_sidebar = False
        self.code_language = None
        self.code = []
        self.blocks = []
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.append(attrs["id"])
        for attribute in ("href", "src"):
            if attrs.get(attribute):
                self.links.append(attrs[attribute])
        if tag == "aside" and "docs-sidebar" in attrs.get("class", "").split():
            self.in_sidebar = True
        if tag == "a" and self.in_sidebar:
            self.nav.append(attrs.get("href"))
            if attrs.get("aria-current") == "page":
                self.current.append(attrs.get("href"))
        if tag == "code" and attrs.get("class", "").startswith("language-"):
            self.code_language = attrs["class"].removeprefix("language-")
            self.code = []

    def handle_data(self, data):
        if self.code_language:
            self.code.append(data)

    def handle_endtag(self, tag):
        if tag == "aside":
            self.in_sidebar = False
        if tag == "code" and self.code_language:
            self.blocks.append((self.code_language, "".join(self.code)))
            self.code_language = None


class DocsTests(unittest.TestCase):
    def test_local_links_and_fragments(self):
        for path in PAGES + [ROOT / "validation/index.html"]:
            page = Page(path)
            self.assertEqual(len(page.ids), len(set(page.ids)), f"Duplicate IDs: {path}")
            for link in page.links:
                url = urlsplit(link)
                if url.scheme or url.netloc:
                    continue
                relative = unquote(url.path)
                target = ((ROOT / relative.lstrip("/")) if relative.startswith("/")
                          else (path.parent / relative) if relative else path)
                if target.is_dir():
                    target /= "index.html"
                with self.subTest(page=str(path.relative_to(ROOT)), link=link):
                    self.assertTrue(target.is_file(), f"Missing target: {target}")
                    if url.fragment and target.suffix == ".html":
                        fragment = unquote(url.fragment)
                        if target.resolve() == ROOT / "firmware/index.html" and fragment in {"distance", "location"}:
                            # These are client-side mode routes, not HTML element IDs.
                            self.assertIn(fragment + "-mode", Page(target).ids)
                            self.assertIn('showFirmwareMode(location.hash', (ROOT / "firmware/tdoa.js").read_text())
                        else:
                            self.assertIn(fragment, Page(target).ids)

    def test_consistent_navigation(self):
        expected = Page(ROOT / "docs/index.html").nav
        self.assertIn("/docs/location/", expected)
        for path in PAGES:
            page = Page(path)
            with self.subTest(page=str(path.relative_to(ROOT))):
                self.assertEqual(page.nav, expected)
                route = "/" + path.parent.relative_to(ROOT).as_posix() + "/"
                self.assertEqual(page.current, [route])

    def test_executable_example_syntax(self):
        for path in PAGES:
            for language, code in Page(path).blocks:
                with self.subTest(page=str(path.relative_to(ROOT)), language=language):
                    if language == "python":
                        ast.parse(code)
                    elif language == "bash":
                        self.assertNotRegex(code, r"\\\\\n", "Doubled backslash breaks shell line continuation")
                        result = subprocess.run(["bash", "-n"], input=code, text=True, capture_output=True)
                        self.assertEqual(result.returncode, 0, result.stderr)

    def test_download_matches_individual_scripts(self):
        directory = ROOT / "docs/scripts"
        names = {"opentag_serial.py", "list_ports.py", "info.py", "monitor.py",
                 "calibrate.py", "static_test.py", "flash.sh", "requirements.txt"}
        with zipfile.ZipFile(directory / "opentags-host-scripts.zip") as archive:
            self.assertEqual(set(archive.namelist()), names)
            self.assertIsNone(archive.testzip())
            for name in names:
                self.assertEqual(archive.read(name), (directory / name).read_bytes(), name)

    def test_site_artifact_includes_footer_destinations(self):
        workflow = (ROOT / ".github/workflows/pages.yaml").read_text()
        copied = re.search(r"cp -R (.+) _site/", workflow).group(1).split()
        for name in copied:
            self.assertTrue((ROOT / name).exists(), name)
        for name in ("docs", "privacy", "terms", "MISSING_THINGS.md"):
            self.assertIn(name, copied)


if __name__ == "__main__":
    unittest.main()
