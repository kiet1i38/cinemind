import { ArrowLeft, ArrowRight, BookmarkSimple, CheckCircle, Globe, Heart, ShieldCheck, Star, UserCircle } from "@phosphor-icons/react";
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import { appConfig, languageOptions } from "./config/appConfig";
import { PosterImage } from "./components/PosterImage";
import { getRuntimeLabel, getTypeLabel } from "./lib/catalog";
import { syncDocumentLanguage, translate } from "./lib/i18n";
import { getCurrentUser, getAuthPageUrl, logout, logoutAll } from "./services/authService";
import { loadCatalog } from "./services/catalogService";
import { getInteractionState, syncPendingInteractions } from "./services/interactionService";
import { clearInteractionState, favoriteStore, mergeInteractionState, watchlistStore } from "./services/interactionStore";
import { languageStore, signalStore } from "./services/signalStore";
import "./styles.css";
import "./profile.css";

function formatDate(value, language) {
  if (!value) return translate(language, "noData");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? translate(language, "noData") : date.toLocaleDateString(language === "vi" ? "vi-VN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
}

function userInitials(user) {
  const words = String(user?.display_name || user?.username || "CM").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "CM";
}

function TitleTile({ record, language, rating }) {
  if (!record) return null;
  return (
    <a className="profile-title-tile" href={`./#${appConfig.routes.titlePrefix}${encodeURIComponent(record.id)}`}>
      <div className="profile-title-poster"><PosterImage record={record} language={language} className="profile-poster" /></div>
      <div className="profile-title-copy">
        <strong title={record.title}>{record.title}</strong>
        <span>{getTypeLabel(record, language)} / {getRuntimeLabel(record, language)}</span>
        {rating === undefined ? null : <span className="profile-rating"><Star size={12} weight="fill" aria-hidden="true" /> {Number(rating).toFixed(1)}</span>}
      </div>
    </a>
  );
}

function EmptyProfileState({ language, children }) {
  return <div className="profile-empty-state"><UserCircle size={25} aria-hidden="true" /><p>{children}</p><a className="profile-inline-link" href="./"><span>{translate(language, "backToCineMind")}</span><ArrowRight size={15} aria-hidden="true" /></a></div>;
}

export default function ProfilePage() {
  const [language, setLanguage] = useState(() => languageStore.read());
  const [user, setUser] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [state, setState] = useState({ ratings: {}, favorites: [], watchlist_items: [] });
  const [loadState, setLoadState] = useState("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    languageStore.write(language);
    syncDocumentLanguage(language);
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    const metadata = {
      locale: language,
      platform: typeof navigator !== "undefined" ? String(navigator.platform || "web").slice(0, 32) : "web"
    };
    const localInteractionState = () => ({
      ratings: signalStore.read(),
      favorites: favoriteStore.read(),
      watchlist: watchlistStore.read()
    });
    const mergeProfileState = (remoteState) => mergeInteractionState(remoteState, localInteractionState());

    async function loadProfile() {
      const [currentUser, records] = await Promise.all([getCurrentUser(), loadCatalog()]);
      if (!currentUser) {
        window.location.href = getAuthPageUrl("login", `${window.location.pathname}${window.location.search}`);
        return;
      }

      let interactionState = null;
      try {
        interactionState = await getInteractionState(metadata);
      } catch {
        // Keep pending browser activity visible while the interaction API recovers.
      }
      if (cancelled) return;
      setUser(currentUser);
      setCatalog(records);
      setState(mergeProfileState(interactionState));
      setLoadState("ready");

      syncPendingInteractions(records, metadata)
        .then(() => getInteractionState(metadata))
        .then((reconciledState) => {
          if (!cancelled) setState(mergeProfileState(reconciledState));
        })
        .catch(() => undefined);
    }

    loadProfile().catch(() => {
      if (!cancelled) setLoadState("error");
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const recordsById = useMemo(() => new Map(catalog.map((record) => [String(record.id), record])), [catalog]);
  const ratedRecords = useMemo(() => Object.entries(state.ratings || {}).map(([showId, item]) => ({ record: recordsById.get(String(showId)), rating: item?.rating })).filter((item) => item.record), [recordsById, state.ratings]);
  const favoriteRecords = useMemo(() => (state.favorites || []).map((showId) => recordsById.get(String(showId))).filter(Boolean), [recordsById, state.favorites]);
  const watchlistRecords = useMemo(() => (state.watchlist_items || []).map((showId) => recordsById.get(String(showId))).filter(Boolean), [recordsById, state.watchlist_items]);

  async function signOut(allDevices = false) {
    const confirmed = window.confirm(translate(language, allDevices ? "logoutAllConfirm" : "logoutConfirm"));
    if (!confirmed) return;
    try {
      if (allDevices) await logoutAll();
      else await logout();
      clearInteractionState();
      window.location.href = "./";
    } catch {
      setMessage(translate(language, "authGenericError"));
    }
  }

  if (loadState === "loading") return <main className="profile-page"><div className="profile-loading"><span className="profile-loading-line" /><span className="profile-loading-line short" /></div></main>;
  if (loadState === "error") return <main className="profile-page"><div className="profile-error"><h1>{translate(language, "authGenericError")}</h1><a className="primary-button" href="./">{translate(language, "backToCineMind")}</a></div></main>;

  return (
    <main className="profile-page">
      <div className="profile-glow profile-glow-left" aria-hidden="true" />
      <div className="profile-glow profile-glow-right" aria-hidden="true" />
      <div className="profile-shell">
        <header className="profile-header">
          <a className="profile-brand" href="./" aria-label={translate(language, "brandHomeLabel", { brand: appConfig.brand.name })}>
            <ArrowLeft size={17} aria-hidden="true" />
            <span className="brand-wordmark"><span>{appConfig.brand.wordmarkPrefix}</span><strong>{appConfig.brand.wordmarkSuffix}</strong></span>
          </a>
          <div className="profile-header-tools">
            <div className="profile-language" role="group" aria-label={translate(language, "languageLabel")}><Globe size={15} aria-hidden="true" />{languageOptions.map((option, index) => <span key={option.value}>{index ? <span aria-hidden="true">/</span> : null}<button type="button" className={language === option.value ? "active" : ""} onClick={() => setLanguage(option.value)}>{translate(language, option.labelKey)}</button></span>)}</div>
            <a className="profile-back-link" href="./">{translate(language, "backToCineMind")}</a>
          </div>
        </header>

        <section className="profile-intro" aria-labelledby="profile-heading">
          <div className="profile-avatar" aria-hidden="true">{userInitials(user)}</div>
          <div className="profile-intro-copy"><p className="profile-eyebrow">{appConfig.brand.name} / {translate(language, "profile")}</p><h1 id="profile-heading">{translate(language, "profileTitle")}</h1><p>{translate(language, "signedInAs", { name: user?.display_name })}</p></div>
          <div className="profile-actions"><button type="button" className="secondary-button" onClick={() => signOut(false)}><ArrowLeft size={15} aria-hidden="true" />{translate(language, "signOut")}</button><button type="button" className="ghost-danger-button" onClick={() => signOut(true)}><ShieldCheck size={15} aria-hidden="true" />{translate(language, "signOutAll")}</button></div>
        </section>

        {message ? <div className="profile-feedback" role="alert"><CheckCircle size={17} aria-hidden="true" />{message}</div> : null}
        <section className="profile-stats" aria-label={translate(language, "accountActivity")}>
          <div><span><Star size={16} aria-hidden="true" />{translate(language, "ratingHistory")}</span><strong>{ratedRecords.length}</strong></div>
          <div><span><Heart size={16} aria-hidden="true" />{translate(language, "favoriteTitles")}</span><strong>{favoriteRecords.length}</strong></div>
          <div><span><BookmarkSimple size={16} aria-hidden="true" />{translate(language, "watchlistTitles")}</span><strong>{watchlistRecords.length}</strong></div>
        </section>

        <section className="profile-account-card" aria-labelledby="account-details-heading"><div className="profile-section-heading"><p className="profile-eyebrow">01 / Identity</p><h2 id="account-details-heading">{translate(language, "accountDetails")}</h2></div><div className="profile-account-grid"><div><span>{translate(language, "profileEmail")}</span><strong>{user?.email}</strong></div><div><span>{translate(language, "profileUsername")}</span><strong>{user?.username}</strong></div><div><span>{translate(language, "memberSince")}</span><strong>{formatDate(user?.created_at, language)}</strong></div></div></section>

        <section className="profile-activity" aria-labelledby="activity-heading"><div className="profile-section-heading"><p className="profile-eyebrow">02 / Library</p><h2 id="activity-heading">{translate(language, "accountActivity")}</h2></div><div className="profile-activity-grid">
          <div className="profile-list-card"><div className="profile-list-heading"><h3>{translate(language, "ratingHistory")}</h3><span>{ratedRecords.length}</span></div>{ratedRecords.length ? <div className="profile-title-grid">{ratedRecords.map(({ record, rating }) => <TitleTile key={record.id} record={record} language={language} rating={rating} />)}</div> : <EmptyProfileState language={language}>{translate(language, "noRatings")}</EmptyProfileState>}</div>
          <div className="profile-list-card"><div className="profile-list-heading"><h3>{translate(language, "favoriteTitles")}</h3><span>{favoriteRecords.length}</span></div>{favoriteRecords.length ? <div className="profile-title-grid">{favoriteRecords.map((record) => <TitleTile key={record.id} record={record} language={language} />)}</div> : <EmptyProfileState language={language}>{translate(language, "noFavorites")}</EmptyProfileState>}</div>
          <div className="profile-list-card profile-list-card-wide"><div className="profile-list-heading"><h3>{translate(language, "watchlistTitles")}</h3><span>{watchlistRecords.length}</span></div>{watchlistRecords.length ? <div className="profile-title-grid">{watchlistRecords.map((record) => <TitleTile key={record.id} record={record} language={language} />)}</div> : <EmptyProfileState language={language}>{translate(language, "noWatchlist")}</EmptyProfileState>}</div>
        </div></section>
        <footer className="profile-footer"><span>{translate(language, "authSecureNote")}</span><a href="./">{translate(language, "backToCineMind")} <ArrowRight size={14} aria-hidden="true" /></a></footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<ProfilePage />);
