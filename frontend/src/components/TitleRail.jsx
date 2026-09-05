import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { translate } from "../lib/i18n";
import { CatalogCard } from "./CatalogCard";

export function TitleRail({ id, title, description, items, language, onSelect, onToggleFavorite, onToggleWatchlist, favoriteIds = [], watchlistIds = [] }) {
  const scrollRail = (direction) => {
    const rail = document.querySelector(`[data-rail="${id}"]`);
    rail?.scrollBy({ left: direction * Math.min(window.innerWidth * 0.82, 720), behavior: "smooth" });
  };

  if (!items.length) return null;

  return (
    <section className="title-section" id={`section-${id}`} aria-labelledby={`${id}-heading`}>
      <div className="section-heading">
        <div>
          <h2 id={`${id}-heading`}>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        <div className="rail-controls" aria-label={`${title} controls`}>
          <button type="button" onClick={() => scrollRail(-1)} aria-label={translate(language, "previousTitles")}>
            <CaretLeft size={18} weight="bold" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => scrollRail(1)} aria-label={translate(language, "nextTitles")}>
            <CaretRight size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="title-rail" data-rail={id} data-testid={`rail-${id}`}>
        {items.map((record) => <CatalogCard key={record.id} record={record} language={language} onSelect={onSelect} onToggleFavorite={onToggleFavorite} onToggleWatchlist={onToggleWatchlist} isFavorite={favoriteIds.includes(String(record.id))} isInWatchlist={watchlistIds.includes(String(record.id))} />)}
      </div>
    </section>
  );
}
