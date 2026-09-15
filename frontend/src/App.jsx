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
  getInteractionContext,
  getInteractionState,
  isRetryableInteractionError,
  recordSearchEvent,
  submitSignal,
  syncPendingInteractions
} from "./services/interactionService";
import { getDiscoverableTitles, getRecentTitles, getRelatedTitles, getTitlesByType } from "./services/recommendationService";
import { catalogPageSizeStore } from "./services/catalogPreferencesStore";
import { AUTH_EVENT_STORAGE_KEY, getAuthPageUrl, getCurrentUser } from "./services/authService";
import { clearInteractionState, consumePendingInteractionLossNotice, getInteractionOwner, hasPendingInteractions, mergeInteractionState, setInteractionOwner } from "./services/interactionStore";
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
  const [authUser, setAuthUser] = useState(null);
  const [authStatus, setAuthStatus] = useState("checking");
  const [authPrompt, setAuthPrompt] = useState(null);
  const [toast, setToast] = useState("");
  const [interactionHydrationVersion, setInteractionHydrationVersion] = useState(0);
  const [activeNavigationTarget, setActiveNavigationTarget] = useState(navigationTargets.home);
  const searchEventSignature = useRef("");
  const languageRef = useRef(language);
  const interactionRevisionRef = useRef(0);
  const signalRequestRevisionsRef = useRef(new Map());
  const authRequestRef = useRef(null);
  const authRevisionRef = useRef(0);
  const authCheckQueuedRef = useRef(false);
  const authRetryRef = useRef(null);
  const catalogRequestRef = useRef({ requestId: 0, controller: null });
  const authUserRef = useRef(null);
  const modalItemRef = useRef(null);
  authUserRef.current = authUser;
  modalItemRef.current = modalItem;

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
      const transition = setInteractionOwner(user?.user_id);
      if (transition.changed) {
        interactionRevisionRef.current += 1;
        signalRequestRevisionsRef.current.clear();
        setInteractionHydrationVersion((version) => version + 1);
      }
      setAuthUser(user);
      setRatings(signalStore.read());
      setAuthStatus(user ? "authenticated" : "anonymous");
    };
    const invalidateAuthRequest = () => {
      authRevisionRef.current += 1;
      authRequestRef.current?.controller?.abort();
      authRequestRef.current = null;
      authCheckQueuedRef.current = false;
    };
    const scheduleAuthRetry = () => {
      if (cancelled || authRetryRef.current !== null) return;
      authRetryRef.current = window.setTimeout(() => {
        authRetryRef.current = null;
        checkAuth();
      }, 3000);
    };
    let checkAuth;
    checkAuth = () => {
      if (cancelled) return;
      if (authRequestRef.current) {
        authCheckQueuedRef.current = true;
        return;
      }
      const revision = authRevisionRef.current;
      setAuthStatus((current) => current === "unavailable" ? current : "checking");
      const controller = new AbortController();
      const request = getCurrentUser({ signal: controller.signal })
        .then((user) => {
          if (cancelled || revision !== authRevisionRef.current) return;
          clearRetry();
          applyConfirmedIdentity(user);
        })
        .catch((error) => {
          if (cancelled || revision !== authRevisionRef.current || error?.name === "AbortError") return;
          if (error?.status === 401 || error?.status === 403) {
            clearRetry();
            applyConfirmedIdentity(null);
            return;
          }
          setAuthStatus("unavailable");
          scheduleAuthRetry();
        })
        .finally(() => {
          if (authRequestRef.current?.promise !== request) return;
          authRequestRef.current = null;
          if (authCheckQueuedRef.current && !cancelled) {
            authCheckQueuedRef.current = false;
            checkAuth();
          }
        });
      authRequestRef.current = { promise: request, controller, revision };
    };
    const retryWhenOnline = () => {
      clearRetry();
      checkAuth();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") checkAuth();
    };
    const handleInteractionAuthRequired = () => {
      invalidateAuthRequest();
      checkAuth();
    };
    const handleAuthStorage = (event) => {
      if (event.key !== AUTH_EVENT_STORAGE_KEY || !event.newValue) return;
      let authEvent;
      try {
        authEvent = JSON.parse(event.newValue);
      } catch {
        return;
      }
      if (authEvent?.type === "logout") {
        invalidateAuthRequest();
        clearRetry();
        interactionRevisionRef.current += 1;
        signalRequestRevisionsRef.current.clear();
        const ownerId = authEvent.ownerId || authUserRef.current?.user_id || getInteractionOwner();
        const preservePendingInteractions = authEvent.preservePendingInteractions === true
          || hasPendingInteractions(ownerId);
        clearInteractionState({
          ownerId,
          clearPending: !preservePendingInteractions
        });
        setAuthUser(null);
        setRatings({});
        setAuthPrompt(null);
        setAuthStatus("anonymous");
        setInteractionHydrationVersion((version) => version + 1);
        return;
      }
      if (authEvent?.type === "login") {
        invalidateAuthRequest();
        checkAuth();
      }
    };

    checkAuth();
    window.addEventListener("online", retryWhenOnline);
    window.addEventListener("storage", handleAuthStorage);
    window.addEventListener("cinemind-auth-required", handleInteractionAuthRequired);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const authPoll = window.setInterval(() => checkAuth(), 60000);
    return () => {
      cancelled = true;
      authRevisionRef.current += 1;
      authRequestRef.current?.controller?.abort();
      authRequestRef.current = null;
      authCheckQueuedRef.current = false;
      clearRetry();
      window.clearInterval(authPoll);
      window.removeEventListener("online", retryWhenOnline);
      window.removeEventListener("storage", handleAuthStorage);
      window.removeEventListener("cinemind-auth-required", handleInteractionAuthRequired);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);
  useEffect(() => {
    signalStore.write(ratings);
  }, [ratings]);

  const interactionMetadata = useCallback(() => ({
    locale: languageRef.current,
    platform: typeof navigator !== "undefined" ? String(navigator.platform || "web").slice(0, 32) : "web"
  }), []);

  useEffect(() => {
    if (!authReady || !catalog.length) return undefined;
    let cancelled = false;
    let retryTimer = null;
    const hydrationOwner = authUser?.user_id ? String(authUser.user_id) : "anonymous";
    const hydrationRevision = interactionRevisionRef.current;
    const applyRemoteState = (state) => {
        if (
          cancelled
          || hydrationRevision !== interactionRevisionRef.current
          || hydrationOwner !== (authUser?.user_id ? String(authUser.user_id) : "anonymous")
        ) return;
        const merged = mergeInteractionState(state, {
          ratings: signalStore.read()
        });
        setRatings(merged.ratings);
    };
    const notifyPendingLoss = () => {
      if (!appConfig.interaction.pendingMutationLossWarning) return;
      const dropped = consumePendingInteractionLossNotice();
      if (dropped > 0) setToast(translate(language, "pendingInteractionsDropped", { count: dropped }));
    };
    const hydrate = () => getInteractionState(interactionMetadata())
      .then((state) => {
        applyRemoteState(state);
        notifyPendingLoss();
        return syncPendingInteractions(catalog, interactionMetadata());
      })
      .then((results) => {
        notifyPendingLoss();
        const hasDefinitiveFailure = Array.isArray(results)
          && results.some((result) => result.status === "rejected"
            && !isRetryableInteractionError(result.reason)
            && result.reason?.code !== "CATALOG_RECORD_UNAVAILABLE");
        if (!hasDefinitiveFailure || cancelled) return;
        return getInteractionState(interactionMetadata()).then(applyRemoteState);
      })
      .catch(() => {
        if (cancelled) return;
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          hydrate();
        }, 3000);
      });
    hydrate();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [authReady, authUser?.user_id, catalog, interactionHydrationVersion, interactionMetadata]);

  useEffect(() => {
    if (!authReady || !catalog.length) return undefined;
    const retryPending = () => {
      syncPendingInteractions(catalog, interactionMetadata())
        .then((results) => {
          const hasDefinitiveFailure = Array.isArray(results)
            && results.some((result) => result.status === "rejected"
              && !isRetryableInteractionError(result.reason)
              && result.reason?.code !== "CATALOG_RECORD_UNAVAILABLE");
          if (!hasDefinitiveFailure) return null;
          return getInteractionState(interactionMetadata()).then((state) => {
            if (authReady) setRatings(mergeInteractionState(state, { ratings: signalStore.read() }).ratings);
          });
        })
        .catch(() => undefined);
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

    const interactionContext = getInteractionContext();
    const signature = [interactionContext.owner, interactionContext.revision, normalizedQuery, type, genre, year, filteredCatalog.length].join("|");
    const timeout = window.setTimeout(() => {
      if (searchEventSignature.current === signature) return;
      searchEventSignature.current = signature;
      recordSearchEvent({
        query: normalizedQuery,
        resultCount: filteredCatalog.length,
        filters: { type, genre, year },
        ...interactionMetadata()
      }, interactionContext)
        .catch(() => undefined)
        .finally(() => {
          const dropped = consumePendingInteractionLossNotice();
          if (dropped > 0) setToast(translate(language, "pendingInteractionsDropped", { count: dropped }));
        });
    }, appConfig.interaction.searchDebounceMs);
    return () => window.clearTimeout(timeout);
  }, [authUser?.user_id, filteredCatalog.length, genre, interactionHydrationVersion, interactionMetadata, query, type, year]);

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
    const boundedQuery = String(nextQuery || "").slice(0, 200);
    setQuery(boundedQuery);
    if (boundedQuery.trim()) {
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
    setInteractionHydrationVersion((version) => version + 1);
    const showId = String(item.id);
    const requestRevision = (signalRequestRevisionsRef.current.get(showId) || 0) + 1;
    signalRequestRevisionsRef.current.set(showId, requestRevision);
    const requestOwner = getInteractionOwner();
    const interactionContext = getInteractionContext();
    const previousSignal = ratings[item.id];
    setRatings((current) => ({ ...current, [item.id]: { ...signal, savedAt: new Date().toISOString() } }));
    const isCurrentRequest = () => requestRevision === signalRequestRevisionsRef.current.get(showId)
      && requestOwner === getInteractionOwner();
    try {
      await submitSignal({ record: item, ...signal, ...interactionMetadata() }, interactionContext);
      if (!isCurrentRequest()) return;
      if (String(modalItemRef.current?.id) !== showId) return;
      setModalItem(null);
      setToast(translate(language, "savedSignal"));
    } catch (error) {
      const dropped = consumePendingInteractionLossNotice();
      if (dropped > 0) setToast(translate(language, "pendingInteractionsDropped", { count: dropped }));
      if (!isCurrentRequest()) return;
      if (isRetryableInteractionError(error)) {
        if (String(modalItemRef.current?.id) === showId) {
          setModalItem(null);
          setToast(translate(language, error.pendingPersisted === false ? "savedSignalSessionOnly" : "savedSignalLocally"));
        }
        return;
      }
      setRatings((current) => {
        const next = { ...current };
        if (previousSignal) next[item.id] = previousSignal;
        else delete next[item.id];
        return next;
      });
      if (error.authRequired || error.status === 401) {
        if (String(modalItemRef.current?.id) === showId) {
          setModalItem(null);
          setAuthPrompt({ action: "rating", title: item.title });
        }
        return;
      }
      if (String(modalItemRef.current?.id) !== showId) return;
      throw Object.assign(error, { userMessage: "signalSaveError" });
    }
  }, [authUser, interactionMetadata, language, modalItem, ratings]);

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
                <TitleRail id="rated" title={translate(language, "ratedTitles")} items={ratedRecords} language={language} onSelect={openModal} />
                <section className="title-section signals-section" id="section-signals" aria-labelledby="signals-heading">
                  <div className="section-heading"><div><h2 id="signals-heading">{translate(language, "previewPicks")}</h2><p>{translate(language, "previewPicksDescription")}</p></div></div>
                  {previewPicks.length ? <div className="title-rail" data-rail="signals" data-testid="rail-signals">{previewPicks.map((record) => <CatalogCard key={record.id} record={record} language={language} onSelect={openModal} />)}</div> : <EmptyState language={language} signals />}
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
