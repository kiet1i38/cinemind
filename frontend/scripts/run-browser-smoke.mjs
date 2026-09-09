import { chromium } from "playwright";
import smoke from "./browser-smoke.mjs";

const baseUrl = process.env.CINEMIND_BASE_URL || "https://kietchaukg.helioho.st/cinemind/";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ignoreHTTPSErrors: false,
  serviceWorkers: "block"
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const report = await smoke(page);
  const requiredChecks = {
    home: report.home === true,
    authUnavailableStillBrowses: report.authUnavailableStillBrowses === true,
    completePosterCoverage: report.catalogPosterCoverage?.completePosterCoverage === true,
    authGate: report.authGate === true,
    authenticatedFlow: report.authenticatedFlow === true,
    invalidRatingRejected: report.invalidRatingRejected === true,
    negativeRatingRejected: report.negativeRatingRejected === true,
    ratingStepRejected: report.ratingStepRejected === true,
    negativeDurationRejected: report.negativeDurationRejected === true,
    durationStepRejected: report.durationStepRejected === true,
    durationUpperBoundRejected: report.durationUpperBoundRejected === true,
    pendingSignalReconciled: report.pendingSignalReconciled === true,
    rapidPreferenceFinalState: report.rapidPreferenceFinalState === "inactive",
    mobileNoHorizontalOverflow: report.mobileNoHorizontalOverflow === true,
    catalogRecovery: report.catalogRecovery === true,
    resetSessionIdParsed: report.resetSessionIdParsed === true
  };
  const failedChecks = Object.entries(requiredChecks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const result = {
    baseUrl,
    requiredChecks,
    failedChecks,
    consoleErrors: report.consoleErrors,
    pageErrors: report.pageErrors,
    report
  };
  console.log(JSON.stringify(result, null, 2));
  if (failedChecks.length || report.pageErrors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
