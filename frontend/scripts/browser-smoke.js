async (page) => {
  const report = {};
  const failures = [];
  const consoleErrors = [];
  const pageErrors = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const onConsole = (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  const onPageError = (error) => pageErrors.push(error.message);
  const waitForHome = async () => {
    try {
      await page.getByTestId("home-page").waitFor({ state: "visible", timeout: 15000 });
    } catch (error) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      throw new Error(`${error.message}; consoleErrors=${JSON.stringify(consoleErrors)}; pageErrors=${JSON.stringify(pageErrors)}; body=${JSON.stringify(bodyText.slice(0, 1200))}`);
    }
  };
  const ownerScoped = async (storageKey) => page.evaluate((key) => {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    if (!(raw && typeof raw === "object" && !Array.isArray(raw) && raw.owners)) return raw || {};
    const owner = JSON.parse(localStorage.getItem("cinemind-interaction-owner") || "\"anonymous\"");
    return raw.owners?.[owner] || {};
  }, storageKey);
  const clearOutbox = async () => page.evaluate(() => {
    const owner = JSON.parse(localStorage.getItem("cinemind-interaction-owner") || "\"anonymous\"");
    localStorage.setItem("cinemind-interaction-outbox", JSON.stringify({ version: 2, owners: { [owner]: { signals: {}, searches: {} } } }));
  });
  const posterStats = async (selector) => page.locator(selector).evaluateAll((cards) => {
    const images = cards.map((card) => card.querySelector(".poster-image img"));
    return {
      cards: cards.length,
      images: images.filter(Boolean).length,
      withSource: images.filter((image) => Boolean(image?.currentSrc || image?.getAttribute("src"))).length,
      broken: images.filter((image) => image?.complete && image.naturalWidth === 0).length,
    };
  });
  const openRating = async () => {
    await page.getByRole("button", { name: "Rate this title", exact: true }).first().click();
    await page.getByTestId("rating-modal").waitFor({ state: "visible" });
  };
  const chooseRating = async (value = 7.5, duration = "12") => {
    await page.getByRole("radio", { name: `${Number(value).toFixed(1)} out of 10` }).click();
    await page.getByRole("spinbutton", { name: "Watch duration" }).fill(String(duration));
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  await page.bringToFront();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().clearCookies();
  await page.goto("http://127.0.0.1:5173/");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState({}, "", "/");
  });
  await page.reload();
  await waitForHome();

  report.home = {
    catalogCount: await page.locator(".filter-count").textContent(),
    rails: await page.locator("[data-testid^=rail-]").count(),
    posters: await posterStats(".catalog-card"),
  };
  expect(report.home.catalogCount === "8807 titles", "catalog count is not 8807");
  expect(report.home.rails >= 4, "expected discovery rails are missing");
  expect(report.home.posters.broken === 0 && report.home.posters.withSource === report.home.posters.images, "home has missing or broken poster sources");
  report.retiredPreferenceUi = {
    preferenceActions: await page.locator(".catalog-card-action").count()
  };
  expect(report.retiredPreferenceUi.preferenceActions === 0, "retired favorite/watchlist controls are still rendered");

  let delayedAuthRequest = true;
  await page.route("**/api/auth/me", async (route) => {
    if (!delayedAuthRequest) {
      await route.continue();
      return;
    }
    delayedAuthRequest = false;
    await page.waitForTimeout(8500);
    try {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "simulated upstream hang" }) });
    } catch {
      // The browser may abort the delayed route after the client timeout.
    }
  });
  await page.reload();
  await waitForHome();
  report.authTimeout = {
    browseAvailable: await page.getByTestId("home-page").isVisible(),
    delayedRequestExpired: delayedAuthRequest === false
  };
  expect(report.authTimeout.browseAvailable, "auth timeout left the shell loading indefinitely");
  await page.unroute("**/api/auth/me");

  const search = page.getByRole("searchbox", { name: "Search the catalog" });
  await search.fill("Stranger Things");
  await page.getByRole("heading", { name: "Search results" }).waitFor();
  report.search = { results: await page.locator(".search-results-grid .catalog-card").count(), posters: await posterStats(".search-results-grid .catalog-card") };
  expect(report.search.results > 0 && report.search.posters.broken === 0, "search results or posters failed");

  const clearFilters = page.getByTestId("filter-bar").getByRole("button", { name: "Clear filters" });
  await clearFilters.click();
  const typeFilter = page.getByRole("combobox", { name: "All titles" });
  const genreFilter = page.getByRole("combobox", { name: "All genres" });
  const yearFilter = page.getByRole("combobox", { name: "All years" });
  await typeFilter.selectOption("Movie");
  await yearFilter.selectOption("2020s");
  const pageSize = page.getByRole("combobox", { name: "Titles per load" });
  await pageSize.selectOption("5");
  const filtered = page.locator(".search-results-grid .catalog-card");
  const beforeMore = await filtered.count();
  await page.getByTestId("load-more-button").click();
  const afterMore = await filtered.count();
  await pageSize.selectOption("50");
  const afterPageSize = await filtered.count();
  report.pagination = {
    type: await typeFilter.inputValue(),
    year: await yearFilter.inputValue(),
    beforeMore,
    afterMore,
    afterPageSize,
    total: await page.locator(".filter-count").textContent(),
    posters: await posterStats(".search-results-grid .catalog-card"),
  };
  expect(report.pagination.beforeMore === 5 && report.pagination.afterMore === 10 && report.pagination.afterPageSize === 50, "pagination/page-size flow failed");
  expect(report.pagination.posters.broken === 0, "filtered catalog has broken posters");
  await clearFilters.click();
  await search.fill("__no_cinemind_title__");
  await page.getByRole("heading", { name: "No titles match those filters" }).waitFor();
  report.emptyState = true;
  await clearFilters.click();

  await page.getByRole("button", { name: "Rate this title", exact: true }).first().click();
  report.anonymousGate = await page.getByText("Keep your signals with you", { exact: true }).count() > 0;
  expect(report.anonymousGate, "anonymous rating gate is missing");
  await page.getByRole("button", { name: "Keep browsing" }).click();

  const account = await page.evaluate(() => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    return { email: `smoke-${suffix}@example.test`, username: `smoke_${suffix.slice(-10)}`, display_name: "Browser Smoke", password: "Browser-Smoke-password-123" };
  });
  const anonymousSessionId = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("cinemind-interaction-session-id") || "null");
    const owner = JSON.parse(localStorage.getItem("cinemind-interaction-owner") || "\"anonymous\"");
    return raw?.owners?.[owner] || raw || null;
  });
  const registration = await page.evaluate(async ({ account: credentials, sessionId }) => {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...credentials, anonymous_session_id: sessionId }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { account, sessionId: anonymousSessionId });
  if (registration.status !== 201) throw new Error(`registration returned ${registration.status}: ${JSON.stringify(registration.body)}`);
  await page.reload();
  await waitForHome();
  report.authenticated = await page.getByRole("button", { name: "Sign in", exact: true }).count() === 0;
  expect(report.authenticated, "registered browser session is not authenticated");

  await openRating();
  report.ratingPicker = {
    choices: await page.getByRole("radio").count(),
    first: await page.getByRole("radio").first().getAttribute("aria-label"),
    noRating: await page.getByText("No rating", { exact: true }).count() > 0,
  };
  expect(report.ratingPicker.choices === 20 && report.ratingPicker.first === "0.5 out of 10" && !report.ratingPicker.noRating, "rating picker boundaries are wrong");
  await page.getByRole("button", { name: "Save signal" }).click();
  report.validation = await page.locator("[role=alert]").count();
  expect(report.validation >= 2, "empty signal submission was not validated");
  await chooseRating(10, "0");
  await page.getByRole("button", { name: "Save signal" }).click();
  await page.getByTestId("rating-modal").waitFor({ state: "detached" });
  report.savedSignal = await page.getByRole("status").textContent();
  expect((report.savedSignal || "").includes("Watch signal saved"), "valid signal was not saved");

  let title404Sessions = 0;
  let title404Signals = 0;
  await page.route("**/api/interaction/sessions", async (route) => { title404Sessions += 1; await route.continue(); });
  await page.route("**/api/interaction/signals", async (route) => {
    title404Signals += 1;
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: { code: "TITLE_NOT_FOUND", message: "Title is not active" } }) });
  });
  await openRating();
  await chooseRating(7.5, "12");
  await page.getByRole("button", { name: "Save signal" }).click();
  await page.locator(".form-error[role=alert]").waitFor({ state: "visible" });
  report.title404 = { signals: title404Signals, sessions: title404Sessions, modalOpen: await page.getByTestId("rating-modal").count() > 0, pending: Object.keys((await ownerScoped("cinemind-interaction-outbox")).signals || {}).length };
  expect(report.title404.signals === 1 && report.title404.sessions === 0 && report.title404.modalOpen && report.title404.pending === 0, "title 404 handling regressed");
  await page.keyboard.press("Escape");
  await page.unroute("**/api/interaction/signals");
  await page.unroute("**/api/interaction/sessions");

  await page.route("**/api/interaction/signals", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: { code: "AUTH_REQUIRED", message: "Authentication required" } }) });
  });
  await openRating();
  await chooseRating(8, "10");
  await page.getByRole("button", { name: "Save signal" }).click();
  await page.getByText("Keep your signals with you", { exact: true }).waitFor({ state: "visible" });
  report.auth401 = { prompt: true, localSuccess: await page.getByText("saved in this browser", { exact: false }).count() > 0, pending: Object.keys((await ownerScoped("cinemind-interaction-outbox")).signals || {}).length };
  expect(!report.auth401.localSuccess && report.auth401.pending === 1, "auth 401 was treated as local success or pending state was lost");
  await page.getByRole("button", { name: "Keep browsing" }).click();
  await page.unroute("**/api/interaction/signals");
  await clearOutbox();

  await page.route("**/api/interaction/signals", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "simulated offline write" }) });
  });
  for (const value of [6.5, 7.5, 8.5]) {
    await openRating();
    await chooseRating(value, "10");
    await page.getByRole("button", { name: "Save signal" }).click();
    await page.getByTestId("rating-modal").waitFor({ state: "detached" });
  }
  const offlineOutbox = await ownerScoped("cinemind-interaction-outbox");
  const offlineSignalEntries = Object.entries(offlineOutbox.signals || {});
  report.offlineEventLog = {
    pendingSignals: offlineSignalEntries.length,
    uniqueMutationIds: new Set(offlineSignalEntries.map(([key, entry]) => entry?.mutationId || key)).size,
    showIds: [...new Set(offlineSignalEntries.map(([, entry]) => entry?.showId).filter(Boolean))]
  };
  expect(report.offlineEventLog.pendingSignals === 3 && report.offlineEventLog.uniqueMutationIds === 3, "offline signal events were overwritten instead of appended");
  await clearOutbox();
  await page.unroute("**/api/interaction/signals");

  const invalidRating = await page.evaluate(async () => {
    const raw = JSON.parse(localStorage.getItem("cinemind-interaction-session-id") || "null");
    const owner = JSON.parse(localStorage.getItem("cinemind-interaction-owner") || "\"anonymous\"");
    const sessionId = raw?.owners?.[owner];
    const catalog = await (await fetch("/data/catalog.json")).json();
    const response = await fetch("/api/interaction/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cinemind-Session": sessionId || "00000000-0000-4000-8000-000000000001" },
      credentials: "include",
      body: JSON.stringify({ session_id: sessionId || "00000000-0000-4000-8000-000000000001", show_id: catalog[0].id, rating: 0, watch_minutes: 0 }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  report.invalidRating = invalidRating.status;
  expect(invalidRating.status === 422, "backend accepted rating 0");

  const mismatchRoute = "**/api/catalog/summary";
  await page.route(mismatchRoute, async (route) => { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 1, source_checksum_sha256: "mismatch" }) }); });
  await page.reload();
  await page.getByRole("heading", { name: "The catalog could not be loaded" }).waitFor({ state: "visible" });
  report.catalogVersionMismatch = true;
  await page.unroute(mismatchRoute);
  await page.reload();
  await waitForHome();

  const invalidCatalogRoute = "**/data/catalog.json";
  await page.route(invalidCatalogRoute, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "broken", title: "Broken" }])
    });
  });
  await page.reload();
  await page.getByRole("heading", { name: "The catalog could not be loaded" }).waitFor({ state: "visible" });
  report.runtimeCatalogValidation = true;
  await page.unroute(invalidCatalogRoute);
  await page.reload();
  await waitForHome();

  await page.getByRole("button", { name: "More info", exact: true }).click();
  await page.locator(".detail-page").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Back to browse" }).click();
  await page.goBack();
  report.detailHistory = { hash: await page.evaluate(() => window.location.hash) };
  expect(!report.detailHistory.hash, "browser Back reopened closed detail");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await waitForHome();
  await page.getByRole("button", { name: "Open menu" }).click();
  report.mobile = { menuVisible: await page.locator(".mobile-nav").isVisible(), documentWidth: await page.evaluate(() => document.documentElement.scrollWidth), viewportWidth: await page.evaluate(() => window.innerWidth) };
  expect(report.mobile.menuVisible && report.mobile.documentWidth <= report.mobile.viewportWidth, "mobile navigation or horizontal overflow failed");
  await page.getByRole("button", { name: "Close" }).click();
  await openRating();
  await page.waitForTimeout(350);
  const dialogBox = await page.getByTestId("rating-modal").boundingBox();
  const backdropBox = await page.locator(".modal-backdrop").boundingBox();
  report.mobileModal = { centered: Boolean(dialogBox && backdropBox && Math.abs((dialogBox.x + dialogBox.width / 2) - (backdropBox.x + backdropBox.width / 2)) < 1 && Math.abs((dialogBox.y + dialogBox.height / 2) - (backdropBox.y + backdropBox.height / 2)) < 1), bodyOverflow: await page.evaluate(() => getComputedStyle(document.body).overflow) };
  expect(report.mobileModal.centered && report.mobileModal.bodyOverflow === "hidden", "mobile rating modal is not centered or scroll locking failed");
  await page.keyboard.press("Escape");

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  if (failures.length || pageErrors.length) {
    throw new Error(JSON.stringify({ failures, consoleErrors, pageErrors }));
  }
  return { report, failures, consoleErrors, pageErrors };
}
