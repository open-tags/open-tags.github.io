const slideshow = document.querySelector("[data-slideshow]");

if (slideshow) {
  const track = slideshow.querySelector(".lab-track");
  const slides = Array.from(slideshow.querySelectorAll(".lab-slide"));
  const thumbs = Array.from(slideshow.querySelectorAll("[data-slide-to]"));
  const previous = slideshow.querySelector("[data-slide-prev]");
  const next = slideshow.querySelector("[data-slide-next]");
  let index = 0;

  function show(nextIndex) {
    index = (nextIndex + slides.length) % slides.length;
    track.style.setProperty("--slide-index", index);
    thumbs.forEach((thumb, thumbIndex) => {
      thumb.classList.toggle("active", thumbIndex === index);
      thumb.setAttribute("aria-current", thumbIndex === index ? "true" : "false");
    });
  }

  previous?.addEventListener("click", () => show(index - 1));
  next?.addEventListener("click", () => show(index + 1));

  thumbs.forEach((thumb) => {
    thumb.addEventListener("click", () => {
      show(Number(thumb.dataset.slideTo));
    });
  });

  slideshow.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") show(index - 1);
    if (event.key === "ArrowRight") show(index + 1);
  });

  const viewport = slideshow.querySelector(".lab-viewport") || slideshow;
  let touchStartX = null;
  let touchStartY = null;
  let touchMoved = false;

  viewport.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    touchMoved = false;
  }, { passive: true });

  viewport.addEventListener("touchmove", (event) => {
    if (touchStartX === null) return;
    const dx = event.touches[0].clientX - touchStartX;
    const dy = event.touches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
      touchMoved = true;
    }
  }, { passive: true });

  viewport.addEventListener("touchend", (event) => {
    if (touchStartX === null) return;
    const endX = event.changedTouches[0].clientX;
    const dx = endX - touchStartX;
    if (touchMoved && Math.abs(dx) > 40) {
      if (dx < 0) show(index + 1);
      else show(index - 1);
    }
    touchStartX = null;
    touchStartY = null;
    touchMoved = false;
  });

  show(0);
}
