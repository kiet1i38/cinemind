import { ArrowUpRight, BookmarkSimple, Check, Clock, Heart, Star } from "@phosphor-icons/react";
import { getRuntimeLabel, getTypeLabel } from "../lib/catalog";
import { translate } from "../lib/i18n";
import { PosterImage } from "./PosterImage";

export function CatalogCard({ record, language, onSelect, onToggleFavorite, onToggleWatchlist, isFavorite = false, isInWatchlist = false }) {
  return (
    <article className="catalog-card" data-testid="catalog-card">
      <button
        type="button"
        className="catalog-card-button group"
        onClick={() => onSelect(record)}
        aria-label={`${translate(language, "rateTitle")}: ${record.title}`}
      >
        <div className="catalog-card-art">
          <PosterImage record={record} language={language} className="catalog-poster" />
          <span className="catalog-card-hover-label">
            <ArrowUpRight size={15} weight="bold" aria-hidden="true" />
            {translate(language, "rateTitle")}
          </span>
        </div>
        <div className="catalog-card-copy">
          <h3 title={record.title}>{record.title}</h3>
          <div className="catalog-card-meta">
            <span>{getTypeLabel(record, language)}</span>
            {record.releaseYear ? <span>{record.releaseYear}</span> : null}
            <span className="catalog-card-runtime"><Clock size={13} weight="bold" aria-hidden="true" /> {getRuntimeLabel(record, language)}</span>
          </div>
          <div className="catalog-card-rating">
            <Star size={13} weight="fill" aria-hidden="true" />
            <span>{record.rating || translate(language, "notListed")}</span>
          </div>
        </div>
      </button>
      <div className="catalog-card-actions">
        <button
          type="button"
          className={`catalog-card-action${isFavorite ? " active" : ""}`}
          onClick={() => onToggleFavorite?.(record, !isFavorite)}
          aria-pressed={isFavorite}
          aria-label={translate(language, isFavorite ? "removeFavorite" : "addFavorite", { title: record.title })}
        >
          {isFavorite ? <Check size={13} weight="bold" aria-hidden="true" /> : <Heart size={13} weight="bold" aria-hidden="true" />}
          <span>{translate(language, isFavorite ? "removeFavoriteShort" : "addFavoriteShort")}</span>
        </button>
        <button
          type="button"
          className={`catalog-card-action${isInWatchlist ? " active" : ""}`}
          onClick={() => onToggleWatchlist?.(record, !isInWatchlist)}
          aria-pressed={isInWatchlist}
          aria-label={translate(language, isInWatchlist ? "removeFromWatchlist" : "addToWatchlist", { title: record.title })}
        >
          {isInWatchlist ? <Check size={13} weight="bold" aria-hidden="true" /> : <BookmarkSimple size={13} weight="bold" aria-hidden="true" />}
          <span>{translate(language, isInWatchlist ? "removeFromWatchlistShort" : "addToWatchlistShort")}</span>
        </button>
      </div>
    </article>
  );
}
