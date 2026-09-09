import { chromium } from "playwright";

const baseUrl = process.env.CINEMIND_BASE_URL || "https://kietchaukg.helioho.st/cinemind/";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ignoreHTTPSErrors: false,
  serviceWorkers: "block"
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

const checks = {};
const findings = [];
const consoleErrors = [];
const pageErrors = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(`${page.url()} :: ${message.text()}`);
});
page.on("pageerror", (error) => pageErrors.push(`${page.url()} :: ${error.message}`));

function check(name, passed, details = "") {
  checks[name] = Boolean(passed);
  if (!passed) findings.push({ name, details });
}

async function open(path) {
  const target = new URL(path, baseUrl).href;
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(800);
}

async function visible(selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function text() {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
}

try {
  await open("");
  await page.getByTestId("home-page").waitFor();
  check("homeRenders", await visible('[data-testid="home-page"]'));
  check("homeSearchVisible", await visible('input[aria-label="Search the catalog"]'));
  check("homeFilterBarVisible", await visible('[data-testid="filter-bar"]'));

  const moreInfo = page.getByRole("button", { name: "More info" }).first();
  check("detailActionAvailable", await moreInfo.count() === 1);
  if (await moreInfo.count()) {
    await moreInfo.click();
    await page.locator(".detail-page h1").waitFor();
    check("detailRouteOpens", /^#\/title\//.test(await page.evaluate(() => window.location.hash)));
    const back = page.getByRole("button", { name: "Back to browse" });
    check("detailBackActionAvailable", await back.count() === 1);
    await back.click();
    await page.getByTestId("home-page").waitFor();
    check("detailBackReturnsHome", await visible('[data-testid="home-page"]'));
  }

  const search = page.getByRole("searchbox", { name: "Search the catalog" });
  await search.fill("__exploratory_no_match__");
  await page.getByRole("heading", { name: "No titles match those filters" }).waitFor();
  check("emptySearchState", await visible("text=No titles match those filters"));
  await page.getByTestId("filter-bar").getByRole("button", { name: "Clear filters" }).click();
  check("clearFiltersRestoresSearch", (await search.inputValue()) === "");

  const typeFilter = page.getByRole("combobox", { name: "All titles" });
  const yearFilter = page.getByRole("combobox", { name: "All years" });
  await typeFilter.selectOption("Movie");
  await yearFilter.selectOption("2020s");
  check("combinedFiltersReturnCards", (await page.locator(".search-results-grid .catalog-card").count()) > 0);
  await page.getByTestId("filter-bar").getByRole("button", { name: "Clear filters" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  check("homeMobileNoOverflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const menu = page.getByRole("button", { name: "Open menu" });
  check("mobileMenuButtonAvailable", await menu.count() === 1);
  if (await menu.count()) {
    await menu.click();
    check("mobileMenuOpens", await visible(".mobile-nav"));
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await open("auth.html?mode=login");
  check("loginFormRenders", await visible("form"));
  check("loginFieldsRender", await page.locator('input[autocomplete="username"], input[autocomplete="current-password"]').count() >= 2);
  const loginInputs = page.locator("form input");
  await loginInputs.nth(0).fill("nonexistent-exploratory@example.test");
  await loginInputs.nth(1).fill("Definitely-wrong-password-123");
  await page.locator('form button[type="submit"]').click();
  await page.waitForTimeout(1_200);
  check("invalidLoginShowsFeedback", (await page.locator('[role="alert"]').count()) > 0 || (await page.locator(".auth-feedback").count()) > 0);

  const authSwitch = page.locator(".auth-switch");
  check("registerSwitchAvailable", await authSwitch.count() === 1);
  if (await authSwitch.count()) await authSwitch.click();
  await page.waitForTimeout(250);
  check("registerModeSwitches", new URL(page.url()).searchParams.get("mode") === "register");
  const registerInputs = page.locator("form input");
  check("registerFieldsRender", await registerInputs.count() === 5);
  if (await registerInputs.count() === 5) {
    await registerInputs.nth(0).fill("exploratory-invalid@example.test");
    await registerInputs.nth(1).fill("exploratory_invalid");
    await registerInputs.nth(2).fill("Exploratory");
    await registerInputs.nth(3).fill("Password-one-123");
    await registerInputs.nth(4).fill("Password-two-123");
    await page.locator('form button[type="submit"]').click();
    await page.waitForTimeout(250);
    check("passwordMismatchShowsFeedback", (await page.locator('[role="alert"]').textContent().catch(() => "")).toLowerCase().includes("match"));
  }
  check("authMobileNoOverflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  await open("profile.html");
  await page.waitForTimeout(1_000);
  check("unauthenticatedProfileRedirects", /auth\.html/.test(new URL(page.url()).pathname) && new URL(page.url()).searchParams.get("mode") === "login");

  await open("reset.html");
  check("resetPageRenders", await visible(".reset-page") && await visible("form.reset-card"));
  check("resetSubmitStartsDisabled", await page.locator('button[type="submit"]').isDisabled());
  const scopes = page.locator('input[type="radio"][name="scope"]');
  check("resetHasThreeScopes", await scopes.count() === 3);
  if (await scopes.count() === 3) {
    await scopes.nth(2).check();
    check("fullResetWarningRenders", await visible(".reset-danger-note"));
    check("fullResetStillRequiresCredentials", await page.locator('button[type="submit"]').isDisabled());
  }
  check("resetMobileNoOverflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  const vietnamese = (await text()).match(/[À-ỹ]+|\b(Mức|hiện tại|Xóa|toàn bộ|Trang riêng|Quay lại|dữ liệu|phim|người|được|không|của|với|xác nhận)\b/gi) || [];
  check("englishOnlyRenderedCopy", vietnamese.length === 0, vietnamese.slice(0, 12).join(", "));
} catch (error) {
  findings.push({ name: "exploratoryRunner", details: error.message });
} finally {
  const result = {
    baseUrl,
    checks,
    findings,
    consoleErrors,
    pageErrors,
    currentUrl: page.url()
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (findings.length || pageErrors.length) process.exitCode = 1;
}
