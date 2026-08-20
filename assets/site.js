const currentPath = window.location.pathname;
const header = document.querySelector("[data-site-header]");

if (header) {
  const current = (path) => currentPath === path || currentPath.startsWith(`${path}/`);
  header.className = "site-header";
  header.innerHTML = `
    <a class="brand" href="/" aria-label="opentags home">opentags</a>
    <button class="nav-toggle" type="button" data-nav-toggle aria-label="Open menu" aria-expanded="false">
      <span class="nav-toggle-icon" aria-hidden="true"></span>
    </button>
    <nav aria-label="Primary">
      <a ${current("/one") ? 'aria-current="page"' : ""} href="/one/">One</a>
      <a ${current("/docs") ? 'aria-current="page"' : ""} href="/docs/">Docs</a>
      <a ${current("/firmware") ? 'aria-current="page"' : ""} href="/firmware/">Console</a>
      <a href="https://github.com/open-tags" rel="noreferrer">GitHub</a>
    </nav>
  `;
}

document.querySelectorAll("body > footer").forEach((footer) => {
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="footer-row">
      <span>&copy; 2026 opentags</span>
      <nav aria-label="Footer">
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
        <a href="mailto:hello@open-tags.com">Contact</a>
      </nav>
    </div>
  `;
});

const toggle = header?.querySelector("[data-nav-toggle]");

if (header && toggle) {
  toggle.addEventListener("click", () => {
    const open = header.classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });

  header.querySelectorAll("nav a").forEach((link) => {
    link.addEventListener("click", () => {
      header.classList.remove("nav-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Open menu");
    });
  });
}

document.querySelectorAll("[data-gallery]").forEach((gallery) => {
  const main = gallery.querySelector("[data-gallery-main] img");
  const thumbs = gallery.querySelectorAll("[data-gallery-thumb]");
  if (!main || !thumbs.length) return;

  thumbs.forEach((thumb) => {
    thumb.addEventListener("click", () => {
      main.src = thumb.dataset.galleryThumb;
      thumbs.forEach((t) => t.classList.toggle("active", t === thumb));
    });
  });
});

const docsSidebar = document.querySelector(".docs-sidebar");
const activeDocsLink = docsSidebar?.querySelector('[aria-current="page"]');

if (docsSidebar && activeDocsLink && window.matchMedia("(max-width: 800px)").matches) {
  requestAnimationFrame(() => {
    docsSidebar.scrollLeft = Math.max(
      0,
      activeDocsLink.offsetLeft - (docsSidebar.clientWidth - activeDocsLink.clientWidth) / 2,
    );
  });
}
