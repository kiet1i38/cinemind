import { Check } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appConfig, catalogConfig, catalogTypes, navigationTargets } from "./config/appConfig";
import { CatalogCard } from "./components/CatalogCard";
import { CatalogPagination } from "./components/CatalogPagination";
import { DetailView } from "./components/DetailView";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { FilterBar } from "./components/FilterBar";
import { Header } from "./components/Header";
import { Hero } from "./components/Hero";
import { LoadingState } from "./components/LoadingState";
import { RatingModal } from "./components/RatingModal";
import { TitleRail } from "./components/TitleRail";
import { closeTitleRoute, filterCatalog, getGenres, getRouteTitleId, openTitleRoute } from "./lib/catalog";
import { translate } from "./lib/i18n";
import { loadCatalog } from "./services/catalogService";
import {
  addFavorite,
  addWatchlistItem,
  getInteractionState,
  recordSearchEvent,
  removeFavorite,
  removeWatchlistItem,
  submitSignal
} from "./services/interactionService";
import { getDiscoverableTitles, getRecentTitles, getRelatedTitles, getTitlesByType } from "./services/recommendationService";
import { catalogPageSizeStore } from "./services/catalogPreferencesStore";
import { favoriteStore, watchlistStore } from "./services/interactionStore";
import { languageStore, signalStore } from "./services/signalStore";

export default function App() {
  const [language, setLanguage] = useState(() => languageStore.read());
  const [catalog, setCatalog] = useState([]);
  const [loadState, setLoadState] = useState("loading");
  const [query, setQuery] = useState("");
  const [type, setType] = useState(catalogConfig.allValue);
  const [genre, setGenre] = useState(catalogConfig.allValue);
  const [year, setYear] = useState(catalogConfig.allValue);
  const [pageSize, setPageSize] = useState(() => catalogPageSizeStore.read());
  const [visibleCount, setVisibleCount] = useState(() => catalogPageSizeStore.read());
  const [modalItem, setModalItem] = useState(null);
  const [routeId, setRouteId] = useState(() => getRouteTitleId());
  const [ratings, setRatings] = useState(() => signalStore.read());
  const [favorites, setFavorites] = useState(() => favoriteStore.read());
  const [watchlist, setWatchlist] = useState(() => watchlistStore.read());
  const [interactionStatus, setInteractionStatus] = useState("local");
  const [toast, setToast] = useState("");
  const searchEventSignature = useRef("");

  const loadData = useCallback((signal) => {
    setLoadState("loading");
    loadCatalog(signal)
      .then((records) => {
        setCatalog(records);
        setLoadState("ready");
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setLoadState("error");
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  useEffect(() => {
    const handleRouteChange = () => setRouteId(getRouteTitleId());
    window.addEventListener("hashchange", handleRouteChange);
    return () => window.removeEventListener("hashchange", handleRouteChange);
  }, []);

  useEffect(() => {
    languageStore.write(language);
  }, [language]);

  useEffect(() => {
    signalStore.write(ratings);
  }, [ratings]);

  useEffect(() => {
    favoriteStore.write(favorites);
  }, [favorites]);

  useEffect(() => {
    watchlistStore.write(watchlist);
  }, [watchlist]);

  const interactionMetadata = useCallback(() => ({
    locale: language,
    platform: typeof navigator !== "undefined" ? String(navigator.platform || "web").slice(0, 32) : "web"
  }), [language]);

  useEffect(() => {
    let cancelled = false;
    getInteractionState(interactionMetadata())
      .then((state) => {
        if (cancelled) return;
        const remoteRatings = Object.fromEntries((state?.ratings || []).map((item) => [
          String(item.show_id),
          {
            rating: Number(item.rating),
            watchMinutes: item.watch_minutes === null ? 0 : Number(item.watch_minutes),
            savedAt: item.rated_at
          }
        ]));
        setRatings(remoteRatings);
        setFavorites((state?.favorites || []).map((item) => String(item.show_id)));
        setWatchlist((state?.watchlist_items || []).map((item) => String(item.show_id)));
        setInteractionStatus("synced");
      })
      .catch(() => {
        if (!cancelled) setInteractionStatus("local");
      });
    return () => {
      cancelled = true;
    };
  }, [interactionMetadata]);

  useEffect(() => {
    catalogPageSizeStore.write(pageSize);
  }, [pageSize]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const genres = useMemo(() => getGenres(catalog), [catalog]);
  const filteredCatalog = useMemo(() => filterCatalog(catalog, { query, type, genre, year }), [catalog, genre, query, type, year]);
  const visibleFilteredCatalog = useMemo(() => filteredCatalog.slice(0, visibleCount), [filteredCatalog, visibleCount]);
  const featured = useMemo(() => getDiscoverableTitles(catalog, catalogConfig.displayLimits.featured)[0], [catalog]);
  const trending = useMemo(() => getDiscoverableTitles(catalog), [catalog]);
  const recent = useMemo(() => getRecentTitles(catalog), [catalog]);
  const movies = useMemo(() => getTitlesByType(catalog, catalogTypes.movie), [catalog]);
  const tvShows = useMemo(() => getTitlesByType(catalog, catalogTypes.tvShow), [catalog]);
  const ratedRecords = useMemo(() => Object.keys(ratings).map((id) => catalog.find((record) => record.id === id)).filter(Boolean), [catalog, ratings]);
  const favoriteRecords = useMemo(() => favorites.map((id) => catalog.find((record) => record.id === id)).filter(Boolean), [catalog, favorites]);
  const watchlistRecords = useMemo(() => watchlist.map((id) => catalog.find((record) => record.id === id)).filter(Boolean), [catalog, watchlist]);
  const lastRated = ratedRecords[ratedRecords.length - 1];
  const previewPicks = useMemo(() => getRelatedTitles(lastRated, catalog), [catalog, lastRated]);
  const routeItem = routeId ? catalog.find((record) => record.id === routeId) : null;
  const routeRelated = useMemo(() => getRelatedTitles(routeItem, catalog), [catalog, routeItem]);
  const hasFilters = Boolean(query.trim() || type !== catalogConfig.allValue || genre !== catalogConfig.allValue || year !== catalogConfig.allValue);

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [genre, pageSize, query, type, year]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      searchEventSignature.current = "";
      return undefined;
    }

    const signature = [normalizedQuery, type, genre, year, filteredCatalog.length].join("|");
    const timeout = window.setTimeout(() => {
      if (searchEventSignature.current === signature) return;
      searchEventSignature.current = signature;
      recordSearchEvent({
        query: normalizedQuery,
        resultCount: filteredCatalog.length,
        filters: { type, genre, year },
        ...interactionMetadata()
      })
        .then(() => setInteractionStatus("synced"))
        .catch(() => setInteractionStatus("local"));
    }, appConfig.interaction.searchDebounceMs);
    return () => window.clearTimeout(timeout);
  }, [filteredCatalog.length, genre, interactionMetadata, query, type, year]);

  const clearFilters = useCallback(() => {
    setQuery("");
    setType(catalogConfig.allValue);
    setGenre(catalogConfig.allValue);
    setYear(catalogConfig.allValue);
  }, []);

  const goHome = useCallback(() => {
    if (window.location.hash) closeTitleRoute();
    setRouteId(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleNavigate = useCallback((target) => {
    if (target === navigationTargets.home) {
      clearFilters();
      goHome();
      return;
    }
    if (target === navigationTargets.movies) {
      clearFilters();
      setType(catalogTypes.movie);
    }
    if (target === navigationTargets.tv) {
      clearFilters();
      setType(catalogTypes.tvShow);
    }
    if (target === navigationTargets.signals) {
      clearFilters();
      goHome();
      window.setTimeout(() => document.getElementById("section-signals")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      return;
    }
    if (target === navigationTargets.movies || target === navigationTargets.tv) {
      goHome();
      window.setTimeout(() => document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    }
  }, [clearFilters, goHome]);

  const openModal = useCallback((item) => setModalItem(item), []);
  const openDetail = useCallback((item) => {
    setModalItem(null);
    openTitleRoute(item.id);
  }, []);
  const backFromDetail = useCallback(() => {
    closeTitleRoute();
    setRouteId(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const saveSignal = useCallback(async (signal) => {
    const item = modalItem;
    if (!item) return;
    setRatings((current) => ({ ...current, [item.id]: { ...signal, savedAt: new Date().toISOString() } }));
    setModalItem(null);
    try {
      await submitSignal({ record: item, ...signal, ...interactionMetadata() });
      setInteractionStatus("synced");
      setToast(translate(language, "savedSignal"));
    } catch {
      setInteractionStatus("local");
      setToast(translate(language, "savedSignalLocally"));
    }
  }, [interactionMetadata, language, modalItem]);

  const toggleFavorite = useCallback(async (record, nextActive) => {
    const id = String(record.id);
    const shouldAdd = typeof nextActive === "boolean" ? nextActive : !favorites.includes(id);
    setFavorites((current) => shouldAdd
      ? [...new Set([...current, id])]
      : current.filter((itemId) => itemId !== id));
    try {
      if (shouldAdd) await addFavorite(record, interactionMetadata());
      else await removeFavorite(record, interactionMetadata());
      setInteractionStatus("synced");
      setToast(translate(language, "preferenceSaved"));
    } catch {
      setInteractionStatus("local");
      setToast(translate(language, "preferenceSavedLocally"));
    }
  }, [favorites, interactionMetadata, language]);

  const toggleWatchlist = useCallback(async (record, nextActive) => {
    const id = String(record.id);
    const shouldAdd = typeof nextActive === "boolean" ? nextActive : !watchlist.includes(id);
    setWatchlist((current) => shouldAdd
      ? [...new Set([...current, id])]
      : current.filter((itemId) => itemId !== id));
    try {
      if (shouldAdd) await addWatchlistItem(record, interactionMetadata());
      else await removeWatchlistItem(record, interactionMetadata());
      setInteractionStatus("synced");
      setToast(translate(language, "preferenceSaved"));
    } catch {
      setInteractionStatus("local");
      setToast(translate(language, "preferenceSavedLocally"));
    }
  }, [interactionMetadata, language, watchlist]);

  if (loadState === "loading") return <><Header language={language} setLanguage={setLanguage} query={query} setQuery={setQuery} onNavigate={handleNavigate} /><LoadingState language={language} /></>;
  if (loadState === "error") return <><Header language={language} setLanguage={setLanguage} query={query} setQuery={setQuery} onNavigate={handleNavigate} /><ErrorState language={language} onRetry={() => loadData()} /></>;

  return (
    <div className="app-shell">
      <Header language={language} setLanguage={setLanguage} query={query} setQuery={setQuery} onNavigate={handleNavigate} />
      {routeId ? (
        <DetailView item={routeItem} related={routeRelated} language={language} onBack={backFromDetail} onRate={openModal} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} isFavorite={routeItem ? favorites.includes(String(routeItem.id)) : false} isInWatchlist={routeItem ? watchlist.includes(String(routeItem.id)) : false} favoriteIds={favorites} watchlistIds={watchlist} />
      ) : (
        <main data-testid="home-page">
          <Hero record={featured} language={language} onRate={openModal} onMoreInfo={openDetail} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} isFavorite={featured ? favorites.includes(String(featured.id)) : false} isInWatchlist={featured ? watchlist.includes(String(featured.id)) : false} />
          <div className="browse-shell" id="catalog">
            <div className="browse-intro">
              <h2>{translate(language, "exploreCatalog")}</h2>
              <p>{translate(language, "exploreDescription")}</p>
            </div>
            <FilterBar language={language} type={type} setType={setType} genre={genre} setGenre={setGenre} year={year} setYear={setYear} genres={genres} resultCount={filteredCatalog.length} hasFilters={hasFilters} clearFilters={clearFilters} pageSize={pageSize} setPageSize={setPageSize} pageSizeOptions={catalogConfig.pagination.pageSizeOptions} />

            {hasFilters ? (
              <section className="search-results-section" aria-labelledby="search-results-heading">
                <div className="section-heading">
                  <div><h2 id="search-results-heading">{translate(language, "searchResults")}</h2><p>{translate(language, "titleCount", { count: filteredCatalog.length })}</p></div>
                </div>
                {filteredCatalog.length ? (
                  <>
                    <div className="search-results-grid">{visibleFilteredCatalog.map((record) => <CatalogCard key={record.id} record={record} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} isFavorite={favorites.includes(String(record.id))} isInWatchlist={watchlist.includes(String(record.id))} />)}</div>
                    <CatalogPagination language={language} displayedCount={visibleFilteredCatalog.length} totalCount={filteredCatalog.length} onLoadMore={() => setVisibleCount((current) => Math.min(current + pageSize, filteredCatalog.length))} />
                  </>
                ) : <EmptyState language={language} onClear={clearFilters} />}
              </section>
            ) : (
              <>
                <TitleRail id="trending" title={translate(language, "trending")} items={trending} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} favoriteIds={favorites} watchlistIds={watchlist} />
                <TitleRail id="recent" title={translate(language, "newest")} items={recent} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} favoriteIds={favorites} watchlistIds={watchlist} />
                <TitleRail id="movies" title={translate(language, "moviesForYou")} items={movies} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} favoriteIds={favorites} watchlistIds={watchlist} />
                <TitleRail id="tv" title={translate(language, "tvForYou")} items={tvShows} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} favoriteIds={favorites} watchlistIds={watchlist} />
                <TitleRail id="rated" title={translate(language, "ratedTitles")} items={ratedRecords} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} favoriteIds={favorites} watchlistIds={watchlist} />
                <TitleRail id="favorites" title={translate(language, "favorites")} items={favoriteRecords} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} favoriteIds={favorites} watchlistIds={watchlist} />
                <TitleRail id="watchlist" title={translate(language, "watchlist")} items={watchlistRecords} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} favoriteIds={favorites} watchlistIds={watchlist} />
                <section className="title-section signals-section" id="section-signals" aria-labelledby="signals-heading">
                  <div className="section-heading"><div><h2 id="signals-heading">{translate(language, "previewPicks")}</h2><p>{translate(language, "previewPicksDescription")}</p></div></div>
                  {previewPicks.length ? <div className="title-rail" data-rail="signals" data-testid="rail-signals">{previewPicks.map((record) => <CatalogCard key={record.id} record={record} language={language} onSelect={openModal} onToggleFavorite={toggleFavorite} onToggleWatchlist={toggleWatchlist} isFavorite={favorites.includes(String(record.id))} isInWatchlist={watchlist.includes(String(record.id))} />)}</div> : <EmptyState language={language} signals />}
                </section>
              </>
            )}
          </div>
        </main>
      )}
      <footer className="app-footer"><p><strong>{appConfig.brand.name}</strong> / {translate(language, "footerNote")}</p><p>{translate(language, "dataNote")} / {translate(language, "signalsSaved", { count: ratedRecords.length })} / <span className="interaction-status" data-testid="interaction-status">{translate(language, interactionStatus === "synced" ? "interactionSynced" : "interactionLocal")}</span></p><p className="footer-attribution">{translate(language, "tmdbAttribution")}</p></footer>
      <RatingModal item={modalItem} language={language} existingSignal={modalItem ? ratings[modalItem.id] : null} onClose={() => setModalItem(null)} onSave={saveSignal} />
      {toast ? <div className="toast" role="status"><Check size={17} weight="bold" aria-hidden="true" />{toast}</div> : null}
    </div>
  );
}
