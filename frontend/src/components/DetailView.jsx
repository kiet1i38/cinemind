import { ArrowLeft, ArrowUpRight, BookmarkSimple, Check, Clock, Heart, Star } from "@phosphor-icons/react";
import { getRuntimeHelper, getRuntimeLabel, getTypeLabel } from "../lib/catalog";
import { translate } from "../lib/i18n";
import { PosterImage } from "./PosterImage";
import { TitleRail } from "./TitleRail";

function detailValue(value, fallback) {
  return value?.length ? value.join(", ") : fallback;
}

export function DetailView({ item, related, language, onBack, onRate, onSelect, onToggleFavorite, onToggleWatchlist, isFavorite = false, isInWatchlist = false, favoriteIds = [], watchlistIds = [] }) {
  if (!item) {
    return (
      <main className="detail-page not-found-page">
        <button type="button" className="back-button" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />{translate(language, "backToBrowse")}</button>
        <div className="empty-state">
          <h1>{translate(language, "titleNotFound")}</h1>
          <p>{translate(language, "titleNotFoundDescription")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="detail-page">
      <div className="detail-inner">
        <button type="button" className="back-button" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />{translate(language, "backToBrowse")}</button>
        <section className="detail-hero" aria-labelledby="detail-heading">
          <div className="detail-poster-wrap"><PosterImage record={item} language={language} className="detail-poster" priority /></div>
          <div className="detail-copy">
            <p className="detail-kicker">{getTypeLabel(item, language)} <span>/</span> {item.releaseYear || translate(language, "notListed")}</p>
            <h1 id="detail-heading">{item.title}</h1>
            <div className="detail-meta">
              <span className="detail-rating"><Star size={15} weight="fill" aria-hidden="true" />{item.rating || translate(language, "notListed")}</span>
              <span><Clock size={15} weight="bold" aria-hidden="true" />{getRuntimeLabel(item, language)}</span>
            </div>
            <p className="detail-description">{item.description || translate(language, "noData")}</p>
            <div className="detail-actions">
              <button type="button" className="primary-button" onClick={() => onRate(item)}>{translate(language, "addToSignals")} <ArrowUpRight size={17} weight="bold" aria-hidden="true" /></button>
              <button type="button" className={`secondary-button preference-button${isFavorite ? " active" : ""}`} onClick={() => onToggleFavorite?.(item, !isFavorite)} aria-pressed={isFavorite} aria-label={translate(language, isFavorite ? "removeFavorite" : "addFavorite", { title: item.title })}>
                {isFavorite ? <Check size={16} weight="bold" aria-hidden="true" /> : <Heart size={16} weight="bold" aria-hidden="true" />}
                {translate(language, isFavorite ? "removeFavoriteShort" : "addFavoriteShort")}
              </button>
              <button type="button" className={`secondary-button preference-button${isInWatchlist ? " active" : ""}`} onClick={() => onToggleWatchlist?.(item, !isInWatchlist)} aria-pressed={isInWatchlist} aria-label={translate(language, isInWatchlist ? "removeFromWatchlist" : "addToWatchlist", { title: item.title })}>
                {isInWatchlist ? <Check size={16} weight="bold" aria-hidden="true" /> : <BookmarkSimple size={16} weight="bold" aria-hidden="true" />}
                {translate(language, isInWatchlist ? "removeFromWatchlistShort" : "addToWatchlistShort")}
              </button>
            </div>
            <p className="detail-runtime-note">{getRuntimeHelper(item, language)}</p>
          </div>
        </section>

        <section className="detail-facts" aria-labelledby="facts-heading">
          <h2 id="facts-heading">{translate(language, "catalogDetails")}</h2>
          <div className="facts-grid">
            <div><span>{translate(language, "description")}</span><strong>{detailValue(item.listedIn, translate(language, "noData"))}</strong></div>
            <div><span>{translate(language, "director")}</span><strong>{item.director || translate(language, "noData")}</strong></div>
            <div><span>{translate(language, "cast")}</span><strong>{detailValue(item.cast, translate(language, "noData"))}</strong></div>
            <div><span>{translate(language, "country")}</span><strong>{detailValue(item.country, translate(language, "noData"))}</strong></div>
            <div><span>{translate(language, "added")}</span><strong>{item.dateAdded || translate(language, "noData")}</strong></div>
          </div>
          <p className="provenance-note">{translate(language, "provenance")}</p>
        </section>

        <TitleRail id="related-detail" title={translate(language, "previewPicks")} description={translate(language, "previewPicksDescription")} items={related} language={language} onSelect={onSelect} onToggleFavorite={onToggleFavorite} onToggleWatchlist={onToggleWatchlist} favoriteIds={favoriteIds} watchlistIds={watchlistIds} />
      </div>
    </main>
  );
}
