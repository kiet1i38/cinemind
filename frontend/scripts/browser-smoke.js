async (page) => {
  const report = {};
  const consoleErrors = [];
  const pageErrors = [];
  const onConsole = (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  const onPageError = (error) => pageErrors.push(error.message);
  const waitForHome = async () => page.getByTestId("home-page").waitFor();
  const readScopedStorage = async (key, fallback) => page.evaluate(({ storageKey, fallbackValue }) => {
    const raw = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    if (!(raw && typeof raw === "object" && !Array.isArray(raw) && raw.owners)) {
      return raw ?? fallbackValue;
    }
    const owner = JSON.parse(window.localStorage.getItem("cinemind-interaction-owner") || '"anonymous"');
    return raw.owners[owner] ?? fallbackValue;
  }, { storageKey: key, fallbackValue: fallback });

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().clearCookies();
  await page.evaluate(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Auth temporarily unavailable" })
  }));
  await page.reload();
  await waitForHome();
  report.authUnavailableStillBrowses = true;
  await page.unroute("**/api/auth/me");
  await page.reload();
  await waitForHome();

  report.home = await page.getByTestId("home-page").isVisible();
  report.catalogCount = await page.locator(".filter-count").textContent();
  report.railCount = await page.locator("[data-testid^=rail-]").count();
  report.catalogPosterCoverage = await page.evaluate(async () => {
    const records = await (await fetch("/data/catalog.json")).json();
    return {
      records: records.length,
      withPosterUrl: records.filter((record) => Boolean(record.posterUrl)).length,
      withFallbackUrl: records.filter((record) => Boolean(record.posterFallbackUrl)).length,
      completePosterCoverage: records.every((record) => Boolean(record.posterUrl || record.posterFallbackUrl))
    };
  });
  const posterStats = async (selector) => page.locator(selector).evaluateAll((cards) => {
    const images = cards.map((card) => card.querySelector(".poster-image img"));
    return {
      cards: cards.length,
      images: images.filter(Boolean).length,
      nonEmptySources: images.filter((image) => image?.getAttribute("src")).length,
      generatedImages: images.filter((image) => image?.dataset.posterKind === "generated").length
    };
  });
  report.homePosterStats = await posterStats(".catalog-card");

  const search = page.getByRole("searchbox", { name: "Search the catalog" });
  await search.fill("Stranger Things");
  await page.getByRole("heading", { name: "Search results" }).waitFor();
  report.searchCount = await page.locator(".search-results-grid .catalog-card").count();
  report.searchPosterStats = await posterStats(".search-results-grid .catalog-card");
  await page.getByTestId("filter-bar").getByRole("button", { name: "Clear filters" }).click();

  const typeFilter = page.getByRole("combobox", { name: "All titles" });
  const yearFilter = page.getByRole("combobox", { name: "All years" });
  await typeFilter.selectOption("Movie");
  await page.getByRole("heading", { name: "Search results" }).waitFor();
  report.movieFilterValue = await typeFilter.inputValue();
  report.movieVisibleCards = await page.locator(".search-results-grid .catalog-card").count();
  await yearFilter.selectOption("2020s");
  report.combinedFilterValues = { type: await typeFilter.inputValue(), year: await yearFilter.inputValue() };
  report.combinedVisibleCards = await page.locator(".search-results-grid .catalog-card").count();
  report.combinedPosterStats = await posterStats(".search-results-grid .catalog-card");

  await page.getByTestId("filter-bar").getByRole("button", { name: "Clear filters" }).click();
  const genreFilter = page.getByRole("combobox", { name: "All genres" });
  await genreFilter.selectOption("Anime Series");
  await yearFilter.selectOption("2020s");
  report.anime2020FilterValues = { genre: await genreFilter.inputValue(), year: await yearFilter.inputValue() };
  report.anime2020VisibleCards = await page.locator(".search-results-grid .catalog-card").count();
  report.anime2020PosterStats = await posterStats(".search-results-grid .catalog-card");
  await page.getByTestId("filter-bar").getByRole("button", { name: "Clear filters" }).click();

  await search.fill("__not_a_real_cinemind_title__");
  await page.getByRole("heading", { name: "No titles match those filters" }).waitFor();
  report.emptyState = true;
  await page.getByTestId("filter-bar").getByRole("button", { name: "Clear filters" }).click();

  await page.getByRole("button", { name: "Rate this title", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  report.authGate = (await page.getByText("Keep your signals with you", { exact: true }).count()) > 0;
  await page.getByRole("button", { name: "Keep browsing" }).click();

  const account = await page.evaluate(() => {
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    return {
      email: `browser-${suffix}@example.test`,
      username: `browser_${suffix.slice(-10)}`,
      display_name: "Browser QA",
      password: "Browser-QA-password-123"
    };
  });
  const anonymousSessionId = await readScopedStorage("cinemind-interaction-session-id", null);
  const registration = await page.evaluate(async (credentials) => {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(credentials)
    });
    return { ok: response.ok, status: response.status };
  }, { ...account, anonymous_session_id: anonymousSessionId });
  if (!registration.ok) throw new Error(`Browser QA registration failed with ${registration.status}`);
  await page.reload();
  await waitForHome();
  report.authenticatedFlow = true;

  await page.getByRole("button", { name: "Rate this title", exact: true }).click();
  await page.getByTestId("rating-modal").waitFor();
  report.tvRuntimeAssumption = (await page.getByText("TV shows use a 45 minute per episode assumption in this prototype.", { exact: true }).count()) > 0;
  await page.getByRole("button", { name: "Save signal" }).click();
  report.requiredErrors = await page.locator("[role=alert]").count();

  const ratingInput = page.getByRole("spinbutton", { name: "Your rating" });
  const durationInput = page.getByRole("spinbutton", { name: "Watch duration" });
  await ratingInput.fill("10.1");
  await durationInput.fill("10");
  await page.getByRole("button", { name: "Save signal" }).click();
  report.invalidRatingRejected = (await page.locator("[role=alert]").first().textContent()).includes("increments");

  await ratingInput.fill("-0.5");
  await page.getByRole("button", { name: "Save signal" }).click();
  report.negativeRatingRejected = await page.locator("[role=alert]").count() > 0;
  await ratingInput.fill("0.1");
  await page.getByRole("button", { name: "Save signal" }).click();
  report.ratingStepRejected = (await page.locator("[role=alert]").first().textContent()).includes("increments");
  await ratingInput.fill("10");
  await durationInput.fill("-1");
  await page.getByRole("button", { name: "Save signal" }).click();
  report.negativeDurationRejected = await page.locator("[role=alert]").count() > 0;
  await durationInput.fill("0.5");
  await page.getByRole("button", { name: "Save signal" }).click();
  report.durationStepRejected = await page.locator("[role=alert]").count() > 0;
  await durationInput.fill("10081");
  await page.getByRole("button", { name: "Save signal" }).click();
  report.durationUpperBoundRejected = (await page.locator("[role=alert]").first().textContent()).includes("10080");

  await ratingInput.fill("0");
  await durationInput.fill("0");
  await page.getByRole("button", { name: "Save signal" }).click();
  await page.getByTestId("rating-modal").waitFor({ state: "detached" });
  const lowerBoundarySignals = await readScopedStorage("cinemind-ratings", {});
  const lowerBoundarySignal = Object.values(lowerBoundarySignals)[0];
  report.lowerBoundarySignal = { rating: lowerBoundarySignal?.rating, watchMinutes: lowerBoundarySignal?.watchMinutes };

  await page.getByRole("button", { name: "Rate this title", exact: true }).click();
  await page.getByTestId("rating-modal").waitFor();
  await ratingInput.fill("10");
  await durationInput.fill("0");
  await page.getByRole("button", { name: "Save signal" }).click();
  await page.getByTestId("rating-modal").waitFor({ state: "detached" });
  const storedSignals = await readScopedStorage("cinemind-ratings", {});
  const storedSignal = Object.values(storedSignals)[0];
  report.savedBoundarySignal = { rating: storedSignal?.rating, watchMinutes: storedSignal?.watchMinutes };
  report.previewRailCards = await page.locator("[data-testid=rail-signals] .catalog-card").count();

  await page.getByRole("button", { name: "Rate this title", exact: true }).click();
  await page.getByTestId("rating-modal").waitFor();
  report.signalPrefill = { rating: await ratingInput.inputValue(), watchMinutes: await durationInput.inputValue() };
  await durationInput.fill("46");
  report.runtimeWarning = await page.locator(".field-warning").count();
  await page.getByRole("button", { name: "Cancel" }).click();

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  await page.route("**/api/interaction/signals", (route) => route.abort());
  await page.getByRole("button", { name: "Rate this title", exact: true }).click();
  await page.getByTestId("rating-modal").waitFor();
  await ratingInput.fill("7");
  await durationInput.fill("5");
  await page.getByRole("button", { name: "Save signal" }).click();
  await page.getByTestId("rating-modal").waitFor({ state: "detached" });
  report.signalQueuedAfterFailure = await page.evaluate(() => {
    const stored = JSON.parse(window.localStorage.getItem("cinemind-interaction-outbox") || "null");
    const owner = JSON.parse(window.localStorage.getItem("cinemind-interaction-owner") || '"anonymous"');
    const outbox = stored?.owners?.[owner] || stored || {};
    return Object.keys(outbox.signals || {}).length > 0;
  });
  report.failureFallbackNotice = await page.getByRole("status").textContent();
  await page.unroute("**/api/interaction/signals");
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForFunction(() => {
    const stored = JSON.parse(window.localStorage.getItem("cinemind-interaction-outbox") || "null");
    const owner = JSON.parse(window.localStorage.getItem("cinemind-interaction-owner") || '"anonymous"');
    const outbox = stored?.owners?.[owner] || stored || {};
    return Object.keys(outbox.signals || {}).length === 0;
  });
  report.pendingSignalReconciled = true;

  const firstFavoriteButton = page.locator(".catalog-card").first().locator("button.catalog-card-action").first();
  await firstFavoriteButton.click();
  await firstFavoriteButton.click();
  await page.waitForFunction(() => {
    const button = document.querySelector(".catalog-card button.catalog-card-action");
    return button?.getAttribute("aria-pressed") === "false";
  });
  report.rapidPreferenceFinalState = "inactive";

  await page.getByRole("button", { name: "More info" }).click();
  await page.locator(".detail-page h1").waitFor();
  report.detailHash = await page.evaluate(() => window.location.hash);
  await page.getByRole("button", { name: "Back to browse" }).click();

  await search.fill("Vendetta: Truth, Lies and The Mafia");
  await page.getByRole("heading", { name: "Search results" }).waitFor();
  const vendettaImage = page.locator(".search-results-grid .catalog-card .poster-image img").first();
  report.dataDrivenPoster = await vendettaImage.count();
  report.dataDrivenPosterKind = await vendettaImage.getAttribute("data-poster-kind");
  await vendettaImage.evaluate((image) => { image.src = "/data/posters/s11.svg"; });
  await page.waitForFunction(() => document.querySelector(".search-results-grid .catalog-card .poster-image img")?.getAttribute("src")?.includes("/data/posters/s11.svg"));
  report.remotePosterFailureFallback = await vendettaImage.getAttribute("src");
  await page.getByTestId("filter-bar").getByRole("button", { name: "Clear filters" }).click();

  await page.getByRole("button", { name: "VI", exact: true }).click();
  await page.getByRole("heading", { name: "Tìm một câu chuyện ở lại với bạn" }).waitFor();
  report.vietnameseHeading = true;
  await page.getByRole("button", { name: "EN", exact: true }).click();
  const signalsAfterLanguageSwitch = await readScopedStorage("cinemind-ratings", {});
  report.localStateSurvivesLanguageSwitch = Object.keys(signalsAfterLanguageSwitch).length > 0;

  await page.setViewportSize({ width: 390, height: 844 });
  report.mobileDesktopNav = await page.locator(".desktop-nav").evaluate((node) => getComputedStyle(node).display);
  await page.getByRole("button", { name: "Open menu" }).click();
  report.mobileMenu = await page.locator(".mobile-nav").count();
  report.mobileNoHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.locator(".mobile-nav button").first().click();

  await page.setViewportSize({ width: 1440, height: 900 });
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  await page.route("**/data/catalog.json", (route) => route.abort());
  await page.reload();
  await page.getByRole("heading", { name: "The catalog could not be loaded" }).waitFor();
  report.catalogFailureState = true;
  await page.unroute("**/data/catalog.json");
  await page.reload();
  await waitForHome();
  report.catalogRecovery = true;

  const resetSessionStorageKey = "cinemind-interaction-session-id";
  const resetProbeSessionId = "00000000-0000-4000-8000-000000000001";
  const resetPageUrl = await page.evaluate(() => new URL("reset.html", window.location.href).href);
  await page.goto(resetPageUrl);
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)), {
    key: resetSessionStorageKey,
    value: resetProbeSessionId
  });
  await page.reload();
  report.resetSessionIdParsed = (await page.locator(".reset-session-label").textContent()) === "Current session found"
    && (await page.locator(".reset-selected-summary small").textContent()).includes(resetProbeSessionId.slice(0, 8))
    && !(await page.locator(".reset-selected-summary small").textContent()).includes('"');
  await page.evaluate((key) => window.localStorage.removeItem(key), resetSessionStorageKey);

  return { ...report, consoleErrors, pageErrors };
}
