// Fixed destinations only: preserve bookmarks and campaign parameters, without
// adding an extra history entry or allowing a query parameter to select a host.
const legacyRoutes = {
  "/one/": "/products/u1/",
  "/start/": "/docs/quickstart/",
};
const legacyPath = window.location.pathname.replace(/index\.html$/, "").replace(/\/?$/, "/");
const destination = legacyRoutes[legacyPath];
if (destination) {
  window.location.replace(`${destination}${window.location.search}${window.location.hash}`);
}
