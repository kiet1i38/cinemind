import { Check } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appConfig, appLanguage, catalogConfig, catalogTypes, navigationTargets } from "./config/appConfig";
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
import { AuthRequiredModal } from "./components/AuthRequiredModal";
import { TitleRail } from "./components/TitleRail";
import { closeTitleRoute, filterCatalog, getGenres, getRouteTitleId, openTitleRoute } from "./lib/catalog";
import { syncDocumentLanguage, translate } from "./lib/i18n";
import { loadCatalog } from "./services/catalogService";
import {
  getInteractionState,
  isRetryableInteractionError,
  recordSearchEvent,
  setFavoritePreference,
  setWatchlistPreference,
  submitSignal,
  syncPendingInteractions
} from "./services/interactionService";
import { getDiscoverableTitles, getRecentTitles, getRelatedTitles, getTitlesByType } from "./services/recommendationService";
import { catalogPageSizeStore } from "./services/catalogPreferencesStore";
import { getAuthPageUrl, getCurrentUser } from "./services/authService";
import {
  favoriteStore,
  mergeInteractionState,
  setInteractionOwner,
  watchlistStore
} from "./services/interactionStore";
import { signalStore } from "./services/signalStore";
import "./authGate.css";

export default function App() {
  const language = appLanguage;
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
  const [authUser, setAuthUser] = useState(null);
  const [authStatus, setAuthStatus] = useState("checking");
  const [authPrompt, setAuthPrompt] = useState(null);
  const [toast, setToast] = useState("");
  const [activeNavigationTarget, setActiveNavigationTarget] = useState(navigationTargets.home);
  const searchEventSignature = useRef("");
  const languageRef = useRef(language);
  const preferenceIntentRef = useRef({ favorites: new Map(), watchlist: new Map() });
  const interactionRevisionRef = useRef(0);
  const authRequestRef = useRef(null);
  const authRetryRef = useRef(null);
  const catalogRequestRef = useRef({ requestId: 0, controller: null });

  const authReady = authStatus === "authenticated" || authStatus === "anonymous";
  const authResolved = authStatus !== "checking";

  const loadData = useCallback(() => {
    const requestId = catalogRequestRef.current.requestId + 1;
    catalogRequestRef.current.controller?.abort();
    const controller = new AbortController();
    catalogRequestRef.current = { requestId, controller };
    setLoadState("loading");
    loadCatalog(controller.signal)
      .then((records) => {
        if (catalogRequestRef.current.requestId !== requestId) return;
        setCatalog(records);
        setLoadState("ready");
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        if (catalogRequestRef.current.requestId !== requestId) return;
        setLoadState("error");
      });
  }, []);

  useEffect(() => {
    loadData();
    return () => {
      catalogRequestRef.current.controller?.abort();
      catalogRequestRef.current = {
        requestId: catalogRequestRef.current.requestId + 1,
        controller: null
      };
    };
  }, [loadData]);

  useEffect(() => {
    const handleRouteChange = () => setRouteId(getRouteTitleId());
    window.addEventListener("hashchange", handleRouteChange);
    return () => window.removeEventListener("hashchange", handleRouteChange);
  }, []);

  useEffect(() => {
    syncDocumentLanguage();
    languageRef.current = language;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const clearRetry = () => {
      if (authRetryRef.current === null) return;
      window.clearTimeout(authRetryRef.current);
      authRetryRef.current = null;
    };
    const applyConfirmedIdentity = (user) => {
      const ownership = setInteractionOwner(user?.user_id);
      // Each account has its own browser namespace. Never clear the new
      // owner's state when the auth check finishes after a user switch.
      if (ownership.changed) setRatings(signalStore.read());
      setAuthUser(user);
      setRatings(signalStore.read());
      setFavorites(favoriteStore.read());
      setWatchlist(watchlistStore.read());
      setAuthStatus(user ? "authenticated" : "anonymous");
    };
    const scheduleAuthRetry = () => {
      if (cancelled || authRetryRef.current !== null) return;
      authRetryRef.current = window.setTimeout(() => {
        authRetryRef.current = null;
        checkAuth();
      }, 3000);
    };
    const checkAuth = () => {
      if (cancelled || authRequestRef.current) return;
      setAuthStatus((current) => current === "unavailable" ? current : "checking");
      const request = getCurrentUser()
        .then((user) => {
          if (cancelled) return;
          clearRetry();
          applyConfirmedIdentity(user);
        })
        .catch((error) => {
          if (cancelled) return;
          if (error?.status === 401 || error?.status === 403) {
            clearRetry();
            applyConfirmedIdentity(null);
            return;
          }
          setAuthStatus("unavailable");
          scheduleAuthRetry();
        })
        .finally(() => {
          authRequestRef.current = null;
        });
      authRequestRef.current = request;
    };
    const retryWhenOnline = () => {
      clearRetry();
      checkAuth();
    };

    checkAuth();
    window.addEventListener("online", retryWhenOnline);
    return () => {
      cancelled = true;
      clearRetry();
      window.removeEventListener("online", retryWhenOnline);
    };
  }, []);

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
    locale: languageRef.current,
    platform: typeof navigator !== "undefined" ? String(navigator.platform || "web").slice(0, 32) : "web"
  }), []);

  useEffect(() => {
    if (!authReady || !catalog.length) return undefined;
    let cancelled = false;
    const hydrationOwner = authUser?.user_id ? String(authUser.user_id) : "anonymous";
    const hydrationRevision = interactionRevisionRef.current;
    getInteractionState(interactionMetadata())
      .then((state) => {
        if (
          cancelled
          || hydrationRevision !== interactionRevisionRef.current
          || hydrationOwner !== (authUser?.user_id ? String(authUser.user_id) : "anonymous")
        ) return;
        const merged = mergeInteractionState(state, {
          ratings: signalStore.read(),
          favorites: favoriteStore.read(),
          watchlist: watchlistStore.read()
        });
        setRatings(merged.ratings);
        setFavorites(merged.favorites);
        setWatchlist(merged.watchlist_items);
        syncPendingInteractions(catalog, interactionMetadata()).catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authReady, authUser?.user_id, catalog, interactionMetadata]);

  useEffect(() => {
    if (!authReady || !catalog.length) return undefined;
    const retryPending = () => {
      syncPendingInteractions(catalog, interactionMetadata()).catch(() => undefined);
    };
    window.addEventListener("online", retryPending);
    const retryIntervalMs = Number.isFinite(appConfig.interaction.pendingRetryIntervalMs)
      && appConfig.interaction.pendingRetryIntervalMs > 0
      ? appConfig.interaction.pendingRetryIntervalMs
      : 30000;
    const interval = window.setInterval(retryPending, retryIntervalMs);
    return () => {
      window.removeEventListener("online", retryPending);
      window.clearInterval(interval);
    };
  }, [authReady, catalog, interactionMetadata]);

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
  const lastRated = useMemo(() => {
    let latestRecord = null;
    let latestTimestamp = Number.NEGATIVE_INFINITY;
    for (const [id, signal] of Object.entries(ratings)) {
      const timestamp = Date.parse(signal?.savedAt || "");
      const record = catalog.find((candidate) => String(candidate.id) === String(id));
      if (record && Number.isFinite(timestamp) && timestamp > latestTimestamp) {
        latestRecord = record;
        latestTimestamp = timestamp;
      }
    }
    return latestRecord || ratedRecords[ratedRecords.length - 1] || null;
  }, [catalog, ratedRecords, ratings]);
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
        .catch(() => undefined);
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
    setActiveNavigationTarget(target);
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

  const handleQueryChange = useCallback((nextQuery) => {
    setQuery(nextQuery);
    if (nextQuery.trim()) {
      if (window.location.hash) closeTitleRoute();
      setRouteId(null);
      setActiveNavigationTarget(null);
    }
  }, []);

  const requestAuth = useCallback((action, item = null) => {
    if (authUser) return false;
    setAuthPrompt({ action, title: item?.title || "" });
    return true;
  }, [authUser]);

  const openModal = useCallback((item) => {
    if (requestAuth("rating", item)) return;
    setModalItem(item);
  }, [requestAuth]);
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
    if (!item || !authUser) return;
    interactionRevisionRef.current += 1;
    const previousSignal = ratings[item.id];
    setRatings((current) => ({ ...current, [item.id]: { ...signal, savedAt: new Date().toISOString() } }));
    try {
      await submitSignal({ record: item, ...signal, ...interactionMetadata() });
      setModalItem(null);
      setToast(translate(language, "savedSignal"));
    } catch (error) {
      if (isRetryableInteractionError(error)) {
        setModalItem(null);
        setToast(translate(language, "savedSignalLocally"));
        return;
      }
      setRatings((current) => {
        const next = { ...current };
        if (previousSignal) next[item.id] = previousSignal;
        else delete next[item.id];
        return next;
      });
      if (error.authRequired || error.status === 401) {
        setModalItem(null);
        setAuthPrompt({ action: "rating", title: item.title });
        return;
      }
      throw Object.assign(error, { userMessage: "signalSaveError" });
    }
  }, [authUser, interactionMetadata, language, modalItem, ratings]);

  const togglePreference = useCallback(async (kind, record, nextActive) => {
    if (requestAuth("preference", record)) return;
    interactionRevisionRef.current += 1;
    const id = String(record.id);
    const intentMap = preferenceIntentRef.current[kind];
    const currentActive = intentMap.has(id)
      ? intentMap.get(id)
      : (kind === "favorites" ? favorites : watchlist).includes(id);
    const shouldAdd = intentMap.has(id) ? !currentActive : (typeof nextActive === "boolean" ? nextActive : !currentActive);
    intentMap.set(id, shouldAdd);
    const update = (current) => shouldAdd
      ? [...new Set([...current, id])]
      : current.filter((itemId) => itemId !== id);
    if (kind === "favorites") setFavorites(update);
    else setWatchlist(update);
    try {
      const save = kind === "favorites" ? setFavoritePreference : setWatchlistPreference;
      await save(record, shouldAdd, interactionMetadata());
      setToast(translate(language, "preferenceSaved"));
    } catch (error) {
      if (isRetryableInteractionError(error)) {
        setToast(translate(language, "preferenceSavedLocally"));
        return;
      }
      if (intentMap.get(id) === shouldAdd) {
        intentMap.delete(id);
        if (kind === "favorites") setFavorites((current) => shouldAdd ? current.filter((itemId) => itemId !== id) : [...new Set([...current, id])]);
        else setWatchlist((current) => shouldAdd ? current.filter((itemId) => itemId !== id) : [...new Set([...current, id])]);
      }
      if (error.authRequired || error.status === 401) {
        setAuthPrompt({ action: "preference", title: record.title });
      } else {
        setToast(translate(language, "preferenceSaveError"));
      }
    }
  }, [favorites, interactionMetadata, language, requestAuth, watchlist]);

  const toggleFavorite = useCallback((record, nextActive) => togglePreference("favorites", record, nextActive), [togglePreference]);
  const toggleWatchlist = useCallback((record, nextActive) => togglePreference("watchlist", record, nextActive), [togglePreference]);

  const headerProps = {
    language,
    query,
    setQuery: handleQueryChange,
    onNavigate: handleNavigate,
    activeTarget: activeNavigationTarget,
    authUser,
    onAuthAction: (mode) => { window.location.href = getAuthPageUrl(mode); }
  };

  if (loadState === "loading" || !authResolved) return <>{authResolved ? <Header {...headerProps} /> : null}<LoadingState language={language} /></>;
  if (loadState === "error") return <><Header {...headerProps} /><ErrorState language={language} onRetry={loadData} /></>;

  return (
    <div className="app-shell">
      <Header {...headerProps} />
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
      <footer className="app-footer"><p><strong>{appConfig.brand.name}</strong> / {translate(language, "footerNote")}</p><p className="footer-attribution">{translate(language, "tmdbAttribution")}</p></footer>
      <RatingModal item={modalItem} language={language} existingSignal={modalItem ? ratings[modalItem.id] : null} onClose={() => setModalItem(null)} onSave={saveSignal} />
      <AuthRequiredModal language={language} action={authPrompt?.action} title={authPrompt?.title} onClose={() => setAuthPrompt(null)} />
      {toast ? <div className="toast" role="status"><Check size={17} weight="bold" aria-hidden="true" />{toast}</div> : null}
    </div>
  );
}
