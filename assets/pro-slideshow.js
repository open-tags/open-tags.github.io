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

  show(0);
}
