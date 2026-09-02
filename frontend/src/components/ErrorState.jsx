import { ArrowClockwise, WarningCircle } from "@phosphor-icons/react";
import { translate } from "../lib/i18n";

export function ErrorState({ language, onRetry }) {
  return (
    <main className="error-page" role="alert">
      <WarningCircle size={36} weight="light" aria-hidden="true" />
      <h1>{translate(language, "loadError")}</h1>
      <p>{translate(language, "loadErrorDescription")}</p>
      <button type="button" className="primary-button" onClick={onRetry}><ArrowClockwise size={17} weight="bold" aria-hidden="true" />{translate(language, "tryAgain")}</button>
    </main>
  );
}
