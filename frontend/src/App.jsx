import { Check } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { filterCatalog, getGenres, getRouteTitleId, closeTitleRoute, openTitleRoute } from "./lib/catalog";
import { translate } from "./lib/i18n";
import { loadCatalog } from "./services/catalogService";
import { getDiscoverableTitles, getRecentTitles, getRelatedTitles, getTitlesByType } from "./services/recommendationService";
import { catalogPageSizeStore } from "./services/catalogPreferencesStore";
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
  const [toast, setToast] = useState("");

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
  const lastRated = ratedRecords[ratedRecords.length - 1];
  const previewPicks = useMemo(() => getRelatedTitles(lastRated, catalog), [catalog, lastRated]);
  const routeItem = routeId ? catalog.find((record) => record.id === routeId) : null;
  const routeRelated = useMemo(() => getRelatedTitles(routeItem, catalog), [catalog, routeItem]);
  const hasFilters = Boolean(query.trim() || type !== catalogConfig.allValue || genre !== catalogConfig.allValue || year !== catalogConfig.allValue);

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [genre, pageSize, query, type, year]);

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
  const saveSignal = useCallback((signal) => {
    if (!modalItem) return;
    setRatings((current) => ({ ...current, [modalItem.id]: { ...signal, savedAt: new Date().toISOString() } }));
    setModalItem(null);
    setToast(translate(language, "savedSignal"));
  }, [language, modalItem]);

  if (loadState === "loading") return <><Header language={language} setLanguage={setLanguage} query={query} setQuery={setQuery} onNavigate={handleNavigate} /><LoadingState language={language} /></>;
  if (loadState === "error") return <><Header language={language} setLanguage={setLanguage} query={query} setQuery={setQuery} onNavigate={handleNavigate} /><ErrorState language={language} onRetry={() => loadData()} /></>;

  return (
    <div className="app-shell">
      <Header language={language} setLanguage={setLanguage} query={query} setQuery={setQuery} onNavigate={handleNavigate} />
      {routeId ? (
        <DetailView item={routeItem} related={routeRelated} language={language} onBack={backFromDetail} onRate={openModal} onSelect={openModal} />
      ) : (
        <main data-testid="home-page">
          <Hero record={featured} language={language} onRate={openModal} onMoreInfo={openDetail} />
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
                    <div className="search-results-grid">{visibleFilteredCatalog.map((record) => <CatalogCard key={record.id} record={record} language={language} onSelect={openModal} />)}</div>
                    <CatalogPagination language={language} displayedCount={visibleFilteredCatalog.length} totalCount={filteredCatalog.length} onLoadMore={() => setVisibleCount((current) => Math.min(current + pageSize, filteredCatalog.length))} />
                  </>
                ) : <EmptyState language={language} onClear={clearFilters} />}
              </section>
            ) : (
              <>
                <TitleRail id="trending" title={translate(language, "trending")} items={trending} language={language} onSelect={openModal} />
                <TitleRail id="recent" title={translate(language, "newest")} items={recent} language={language} onSelect={openModal} />
                <TitleRail id="movies" title={translate(language, "moviesForYou")} items={movies} language={language} onSelect={openModal} />
                <TitleRail id="tv" title={translate(language, "tvForYou")} items={tvShows} language={language} onSelect={openModal} />
                <section className="title-section signals-section" id="section-signals" aria-labelledby="signals-heading">
                  <div className="section-heading"><div><h2 id="signals-heading">{translate(language, "previewPicks")}</h2><p>{translate(language, "previewPicksDescription")}</p></div></div>
                  {previewPicks.length ? <div className="title-rail" data-rail="signals" data-testid="rail-signals">{previewPicks.map((record) => <CatalogCard key={record.id} record={record} language={language} onSelect={openModal} />)}</div> : <EmptyState language={language} signals />}
                </section>
              </>
            )}
          </div>
        </main>
      )}
      <footer className="app-footer"><p><strong>{appConfig.brand.name}</strong> / {translate(language, "footerNote")}</p><p>{translate(language, "dataNote")} / {translate(language, "signalsSaved", { count: ratedRecords.length })}</p><p className="footer-attribution">{translate(language, "tmdbAttribution")}</p></footer>
      <RatingModal item={modalItem} language={language} existingSignal={modalItem ? ratings[modalItem.id] : null} onClose={() => setModalItem(null)} onSave={saveSignal} />
      {toast ? <div className="toast" role="status"><Check size={17} weight="bold" aria-hidden="true" />{toast}</div> : null}
    </div>
  );
}
