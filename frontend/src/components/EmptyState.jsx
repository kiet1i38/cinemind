import { FilmStrip } from "@phosphor-icons/react";
import { translate } from "../lib/i18n";

export function EmptyState({ language, signals = false, onClear }) {
  return (
    <div className="empty-state" data-testid="empty-state">
      <FilmStrip size={34} weight="light" aria-hidden="true" />
      <h2>{signals ? translate(language, "noSignalsTitle") : translate(language, "noResultsTitle")}</h2>
      <p>{signals ? translate(language, "noSignalsDescription") : translate(language, "noResultsDescription")}</p>
      {onClear ? <button type="button" className="secondary-button" onClick={onClear}>{translate(language, "clearFilters")}</button> : null}
    </div>
  );
}
