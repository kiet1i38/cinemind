import { ArrowLeft, ArrowRight, CheckCircle, Globe, LockKey } from "@phosphor-icons/react";
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import { appConfig, authConfig, languageOptions } from "./config/appConfig";
import { PosterImage } from "./components/PosterImage";
import { syncDocumentLanguage, translate } from "./lib/i18n";
import { loadCatalog } from "./services/catalogService";
import { getCurrentUser, login, register } from "./services/authService";
import { languageStore } from "./services/signalStore";
import "./styles.css";
import "./auth.css";

function getMode() {
  return new URLSearchParams(window.location.search).get("mode") === "register" ? "register" : "login";
}

function safeReturnTo(value) {
  if (typeof value !== "string" || !value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "./";
  try {
    const resolved = new URL(value, window.location.origin);
    return resolved.origin === window.location.origin ? value : "./";
  } catch {
    return "./";
  }
}

function errorCopy(error, language) {
  if (error?.status === 401) return translate(language, "authInvalidCredentials");
  if (error?.status === 409) return translate(language, "authDuplicateAccount");
  return error?.status === 400 ? error.message : translate(language, "authGenericError");
}

export default function AuthPage() {
  const [language, setLanguage] = useState(() => languageStore.read());
  const [mode, setMode] = useState(getMode);
  const [catalog, setCatalog] = useState([]);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [requestState, setRequestState] = useState("idle");
  const [message, setMessage] = useState("");
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [authCheckState, setAuthCheckState] = useState("checking");

  const returnTo = useMemo(() => safeReturnTo(new URLSearchParams(window.location.search).get("returnTo")), []);
  const featured = catalog.find((record) => record.posterUrl || record.posterFallbackUrl) || catalog[0] || null;

  useEffect(() => {
    languageStore.write(language);
    syncDocumentLanguage(language);
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then((user) => {
        if (cancelled) return;
        if (user) {
          window.location.replace(returnTo);
          return;
        }
        setAuthCheckState("ready");
      })
      .catch(() => {
        if (!cancelled) setAuthCheckState("ready");
      });
    return () => {
      cancelled = true;
    };
  }, [returnTo]);

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((records) => {
        if (!cancelled) setCatalog(records);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      };
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return undefined;

    function syncKeyboardState() {
      setKeyboardOpen(Math.max(0, window.innerHeight - viewport.height) > 120);
    }

    syncKeyboardState();
    viewport.addEventListener("resize", syncKeyboardState);
    return () => viewport.removeEventListener("resize", syncKeyboardState);
  }, []);

  function switchMode(nextMode) {
    setMode(nextMode);
    setMessage("");
    setPassword("");
    setConfirmPassword("");
    const url = new URL(window.location.href);
    url.searchParams.set("mode", nextMode);
    window.history.replaceState({}, "", url);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setMessage("");
    if (mode === "register" && password !== confirmPassword) {
      setMessage(translate(language, "passwordMismatch"));
      setRequestState("error");
      return;
    }
    setRequestState("submitting");
    try {
      if (mode === "register") {
        await register({ email, username, displayName, password });
      } else {
        await login({ identifier: email, password });
      }
      setRequestState("success");
      setMessage(translate(language, mode === "register" ? "accountCreated" : "loginSuccess"));
      window.setTimeout(() => { window.location.href = returnTo; }, 260);
    } catch (error) {
      setRequestState("error");
      setMessage(errorCopy(error, language));
    }
  }

  if (authCheckState === "checking") {
    return <main className="auth-page auth-page--checking" aria-busy="true"><div className="auth-checking-state" role="status">{translate(language, "checkingSession")}</div></main>;
  }

  return (
    <main className={`auth-page auth-page--${mode}${keyboardOpen ? " auth-page--keyboard" : ""}`}>
      <div className="auth-backdrop-glow auth-backdrop-glow-left" aria-hidden="true" />
      <div className="auth-backdrop-glow auth-backdrop-glow-right" aria-hidden="true" />
      <div className="auth-shell">
        <header className="auth-header">
          <a className="auth-brand" href="./" aria-label={translate(language, "brandHomeLabel", { brand: appConfig.brand.name })}>
            <ArrowLeft size={17} aria-hidden="true" />
            <span className="brand-wordmark"><span>{appConfig.brand.wordmarkPrefix}</span><strong>{appConfig.brand.wordmarkSuffix}</strong></span>
          </a>
          <div className="auth-header-tools">
            <div className="auth-language" role="group" aria-label={translate(language, "languageLabel")}>
              <Globe size={15} aria-hidden="true" />
              {languageOptions.map((option, index) => <span key={option.value} className="auth-language-item">
                {index > 0 ? <span aria-hidden="true">/</span> : null}
                <button type="button" className={language === option.value ? "active" : ""} onClick={() => setLanguage(option.value)}>{translate(language, option.labelKey)}</button>
              </span>)}
            </div>
            <span className="auth-header-note"><LockKey size={14} aria-hidden="true" /> {translate(language, "secureSessionNote")}</span>
          </div>
        </header>

        <div className="auth-layout">
          <section className="auth-story" aria-labelledby="auth-story-title">
            <div className="auth-story-copy">
              <p className="auth-eyebrow">{appConfig.brand.name} / {translate(language, "account")}</p>
              <h1 id="auth-story-title">{translate(language, mode === "register" ? "registerTitle" : "loginTitle")}</h1>
              <p>{translate(language, mode === "register" ? "registerSubtitle" : "loginSubtitle")}</p>
            </div>
            {featured ? (
              <div className="auth-feature-card">
                <div className="auth-feature-poster"><PosterImage record={featured} language={language} className="auth-feature-image" priority /></div>
                <div className="auth-feature-caption"><span>{translate(language, "authFeaturedLabel")}</span><strong>{featured.title}</strong><small>{featured.type} / {featured.releaseYear || translate(language, "notListed")}</small></div>
              </div>
            ) : <div className="auth-feature-placeholder" aria-hidden="true" />}
          </section>

          <section className="auth-form-card" aria-labelledby="auth-form-title">
            <div className="auth-form-heading">
              <p className="auth-card-kicker">{translate(language, mode === "register" ? "authSectionAccount" : "authSectionAccess")}</p>
              <h2 id="auth-form-title">{translate(language, mode === "register" ? "createAccount" : "signIn")}</h2>
              <p>{translate(language, mode === "register" ? "registerMergeNote" : "loginMergeNote")}</p>
            </div>
            <form onSubmit={handleSubmit}>
              {mode === "register" ? <>
                <label className="auth-field"><span>{translate(language, "emailLabel")}</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required maxLength={320} /></label>
                <label className="auth-field"><span>{translate(language, "usernameLabel")}</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required minLength={authConfig.usernameMinLength} maxLength={authConfig.usernameMaxLength} /></label>
                <label className="auth-field"><span>{translate(language, "displayNameLabel")}</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required maxLength={authConfig.displayNameMaxLength} /></label>
              </> : <label className="auth-field"><span>{translate(language, "identifierLabel")}</span><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label>}
              <label className="auth-field"><span>{translate(language, "passwordLabel")}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={authConfig.passwordMinLength} maxLength={authConfig.passwordMaxLength} /></label>
              {mode === "register" ? <label className="auth-field"><span>{translate(language, "confirmPasswordLabel")}</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required minLength={authConfig.passwordMinLength} maxLength={authConfig.passwordMaxLength} /></label> : null}
              {message ? <div className={`auth-feedback ${requestState}`} role={requestState === "error" ? "alert" : "status"}>{requestState === "success" ? <CheckCircle size={17} weight="fill" aria-hidden="true" /> : null}<span>{message}</span></div> : null}
              <button className="auth-submit" type="submit" disabled={requestState === "submitting" || requestState === "success"}>{requestState === "submitting" ? translate(language, "working") : translate(language, mode === "register" ? "registerSubmit" : "loginSubmit")} <ArrowRight size={17} weight="bold" aria-hidden="true" /></button>
            </form>
            <button type="button" className="auth-switch" onClick={() => switchMode(mode === "register" ? "login" : "register")}>
              {translate(language, mode === "register" ? "switchToLogin" : "switchToRegister")}
            </button>
          </section>
        </div>
        <footer className="auth-footer"><span>{translate(language, "authFooter")}</span><span>{translate(language, "authSecureNote")}</span></footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<AuthPage />);
