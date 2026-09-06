import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { translate } from "../lib/i18n";
import { CatalogCard } from "./CatalogCard";

export function TitleRail({ id, title, description, items, language, onSelect, onToggleFavorite, onToggleWatchlist, favoriteIds = [], watchlistIds = [] }) {
  const railRef = useRef(null);
  const [scrollState, setScrollState] = useState({ canScrollPrev: false, canScrollNext: false });

  const updateScrollState = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const nextState = {
      canScrollPrev: rail.scrollLeft > 4,
      canScrollNext: maxScrollLeft - rail.scrollLeft > 1
    };
    setScrollState((current) => current.canScrollPrev === nextState.canScrollPrev && current.canScrollNext === nextState.canScrollNext ? current : nextState);
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    updateScrollState();
    rail.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateScrollState);
    resizeObserver?.observe(rail);
    return () => {
      rail.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
      resizeObserver?.disconnect();
    };
  }, [items.length, updateScrollState]);

  const scrollRail = (direction) => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, rail.scrollLeft + direction * Math.min(window.innerWidth * 0.82, 720)));
    rail.scrollTo({ left: nextScrollLeft, behavior: "smooth" });
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
          <button type="button" onClick={() => scrollRail(-1)} aria-label={translate(language, "previousTitles")} aria-controls={`rail-${id}`} disabled={!scrollState.canScrollPrev}>
            <CaretLeft size={18} weight="bold" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => scrollRail(1)} aria-label={translate(language, "nextTitles")} aria-controls={`rail-${id}`} disabled={!scrollState.canScrollNext}>
            <CaretRight size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div ref={railRef} className="title-rail" id={`rail-${id}`} data-rail={id} data-testid={`rail-${id}`}>
        {items.map((record) => <CatalogCard key={record.id} record={record} language={language} onSelect={onSelect} onToggleFavorite={onToggleFavorite} onToggleWatchlist={onToggleWatchlist} isFavorite={favoriteIds.includes(String(record.id))} isInWatchlist={watchlistIds.includes(String(record.id))} />)}
      </div>
    </section>
  );
}
