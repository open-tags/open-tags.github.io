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

// Muted inline video should autoplay, but some browsers (iOS Low Power Mode,
// data saver) block it; retry on load and on the first interaction.
document.querySelectorAll("video[data-autoplay]").forEach((video) => {
  const play = () => video.play().catch(() => {});
  video.muted = true;
  if (video.paused) play();
  const resume = () => {
    if (video.paused) play();
  };
  ["touchstart", "pointerdown", "scroll", "keydown"].forEach((type) =>
    window.addEventListener(type, resume, { once: true, passive: true })
  );
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resume();
  });
});
