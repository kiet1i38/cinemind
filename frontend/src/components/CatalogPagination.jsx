import { translate } from "../lib/i18n";

export function CatalogPagination({ language, displayedCount, totalCount, onLoadMore }) {
  const visibleCount = Math.min(displayedCount, totalCount);
  const canLoadMore = visibleCount < totalCount;

  return (
    <div className="catalog-pagination" data-testid="catalog-pagination">
      <p className="catalog-pagination-summary" aria-live="polite">
        {translate(language, "showingTitles", { visible: visibleCount, total: totalCount })}
      </p>
      {canLoadMore ? (
        <button type="button" className="secondary-button load-more-button" onClick={onLoadMore} data-testid="load-more-button">
          {translate(language, "loadMore")}
        </button>
      ) : (
        <p className="catalog-pagination-end">{translate(language, "allTitlesLoaded")}</p>
      )}
    </div>
  );
}
