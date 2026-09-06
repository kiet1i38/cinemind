import { Globe, List, MagnifyingGlass, X } from "@phosphor-icons/react";
import { Fragment, useState } from "react";
import { appConfig, languageOptions } from "../config/appConfig";
import { translate } from "../lib/i18n";

function userInitials(user) {
  const words = String(user?.display_name || user?.username || "CM").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "CM";
}

export function Header({ language, setLanguage, query, setQuery, onNavigate, activeTarget, authUser, onAuthAction }) {
  const [menuOpen, setMenuOpen] = useState(false);

  const navigate = (target) => {
    setMenuOpen(false);
    onNavigate(target);
  };

  return (
    <header className="site-header">
      <div className="header-inner">
        <button type="button" className="brand-lockup" onClick={() => navigate(appConfig.navigation[0].target)} aria-label={translate(language, "brandHomeLabel", { brand: appConfig.brand.name })}>
          <span className="brand-wordmark"><span>{appConfig.brand.wordmarkPrefix}</span><strong>{appConfig.brand.wordmarkSuffix}</strong></span>
          <span className="brand-tagline">{translate(language, "brandTagline")}</span>
        </button>

        <nav className="desktop-nav" aria-label={translate(language, "primaryNavigation")}>
          {appConfig.navigation.map((item) => {
            const isActive = item.target === activeTarget;
            return <button key={item.target} type="button" className={`nav-link${isActive ? " active" : ""}`} onClick={() => navigate(item.target)} aria-current={isActive ? "page" : undefined}>{translate(language, item.labelKey)}</button>;
          })}
        </nav>

        <div className="header-actions">
          <label className="header-search">
            <MagnifyingGlass size={18} weight="regular" aria-hidden="true" />
            <span className="sr-only">{translate(language, "searchLabel")}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate(language, "searchPlaceholder")}
              aria-label={translate(language, "searchLabel")}
            />
          </label>
          <div className="language-switcher" role="group" aria-label={translate(language, "languageLabel")}>
            <Globe size={16} weight="regular" aria-hidden="true" />
            {languageOptions.map((option, index) => <Fragment key={option.value}>
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              <button type="button" className={language === option.value ? "language-active" : ""} onClick={() => setLanguage(option.value)} aria-pressed={language === option.value}>{translate(language, option.labelKey)}</button>
            </Fragment>)}
          </div>
          <button type="button" className="mobile-menu-button" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? translate(language, "close") : translate(language, "openMenu")} aria-expanded={menuOpen}>
            {menuOpen ? <X size={22} aria-hidden="true" /> : <List size={22} aria-hidden="true" />}
          </button>
          {authUser ? (
            <a className="profile-link" href={`./${appConfig.auth.profilePage}`} aria-label={translate(language, "viewProfile")}>
              <span className="profile-mark" aria-hidden="true">{userInitials(authUser)}</span>
              <span className="profile-name">{authUser.display_name}</span>
            </a>
          ) : (
            <button type="button" className="header-auth-button" onClick={() => onAuthAction?.("login")}>
              {translate(language, "signIn")}
            </button>
          )}
        </div>
      </div>
      {menuOpen ? (
        <nav className="mobile-nav" aria-label={translate(language, "mobileNavigation")}>
          {appConfig.navigation.map((item) => {
            const isActive = item.target === activeTarget;
            return <button key={item.target} type="button" className={isActive ? "active" : ""} onClick={() => navigate(item.target)} aria-current={isActive ? "page" : undefined}>{translate(language, item.labelKey)}</button>;
          })}
        </nav>
      ) : null}
    </header>
  );
}
