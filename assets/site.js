const header = document.querySelector("[data-site-header]");

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
