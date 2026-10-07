const purchases = [...document.querySelectorAll("[data-kit-purchase]")];

function setShippingRegion(region) {
  const global = region === "global";
  purchases.forEach((purchase) => {
    purchase.querySelectorAll('input[type="radio"]').forEach((input) => {
      input.checked = input.value === region;
    });
    const link = purchase.querySelector("[data-buy-link]");
    const note = purchase.querySelector("[data-shipping-note]");
    link.href = global ? link.dataset.globalUrl : link.dataset.usUrl;
    const total = global ? link.dataset.globalTotal : link.dataset.usTotal;
    link.textContent = `Buy ${link.dataset.kitName} · $${total}`;
    note.textContent = global ? "$50 international shipping" : "Free U.S. shipping";
  });
}

purchases.forEach((purchase) => {
  const toggle = purchase.querySelector(".kit-shipping-toggle");
  toggle.hidden = false;
  toggle.addEventListener("change", (event) => {
    if (event.target.matches('input[type="radio"]')) {
      setShippingRegion(event.target.value);
    }
  });
});

setShippingRegion("us");
