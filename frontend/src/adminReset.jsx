import { ArrowLeft, CheckCircle, ShieldCheck, Warning, XCircle } from "@phosphor-icons/react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { appConfig } from "./config/appConfig";
import {
  clearLocalInteractionState,
  readCurrentInteractionSession,
  resetDatabase
} from "./services/adminResetService";
import "./adminReset.css";

const resetConfig = appConfig.adminReset;
const scopeCards = [
  {
    value: "interaction",
    eyebrow: "Level 1",
    title: "Current session",
    description: "Delete ratings, watch sessions, and search events for this browser.",
    warning: "The catalog is preserved."
  },
  {
    value: "demo",
    eyebrow: "Level 2",
    title: "Demo data",
    description: "Delete all dynamic application data to start a clean demonstration.",
    warning: "Anonymous sessions from other testers are also deleted."
  },
  {
    value: "full",
    eyebrow: "Level 3",
    title: "All user data",
    description: "Delete all application users, auth sessions, and interaction data.",
    warning: "The catalog, migration history, and ops audit are preserved."
  }
];

function formatResetTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AdminResetPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [scope, setScope] = useState("interaction");
  const [confirmation, setConfirmation] = useState("");
  const [requestState, setRequestState] = useState("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState(null);
  const [sessionId, setSessionId] = useState(() => readCurrentInteractionSession());
  const selectedScope = scopeCards.find((card) => card.value === scope) || scopeCards[0];
  const expectedPhrase = resetConfig.confirmationPhrases[scope];
  const hasCurrentSession = Boolean(sessionId);
  const canSubmit = Boolean(username.trim() && password && confirmation === expectedPhrase)
    && !(scope === "interaction" && !hasCurrentSession)
    && requestState !== "submitting";

  async function handleSubmit(event) {
    event.preventDefault();
    setRequestState("submitting");
    setMessage("");
    setResult(null);
    try {
      const response = await resetDatabase({
        username: username.trim(),
        password,
        scope,
        confirmation,
        sessionId
      });
      clearLocalInteractionState();
      setSessionId(null);
      setPassword("");
      setConfirmation("");
      setResult(response);
      setMessage("Reset completed successfully.");
      setRequestState("success");
    } catch (error) {
      setMessage(error.message || "The reset request could not be completed.");
      setRequestState("error");
    }
  }

  return (
    <main className="reset-page">
      <div className="reset-orb reset-orb-left" aria-hidden="true" />
      <div className="reset-orb reset-orb-right" aria-hidden="true" />
      <div className="reset-shell">
        <header className="reset-header">
          <a className="reset-back-link" href="./" aria-label="Back to CineMind">
            <ArrowLeft size={17} aria-hidden="true" />
            <span>CineMind</span>
          </a>
          <span className="reset-header-label">Protected maintenance</span>
        </header>

        <section className="reset-hero" aria-labelledby="reset-title">
          <div className="reset-hero-icon" aria-hidden="true"><ShieldCheck size={25} weight="duotone" /></div>
          <p className="reset-eyebrow">CineMind / Admin console</p>
          <h1 id="reset-title">Reset data safely.</h1>
          <p className="reset-lede">A dedicated page for cleaning test data. Every operation requires Basic Auth and the confirmation phrase for the selected reset level.</p>
        </section>

        <form className="reset-card" onSubmit={handleSubmit}>
          <div className="reset-card-heading">
            <div>
              <p className="reset-card-eyebrow">01 / Access</p>
              <h2>Admin credentials</h2>
            </div>
            <span className="reset-lock-label">Not stored</span>
          </div>
          <div className="reset-auth-grid">
            <label className="reset-field">
              <span>Username</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
            </label>
            <label className="reset-field">
              <span>Password</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
          </div>

          <div className="reset-card-heading reset-scope-heading">
            <div>
              <p className="reset-card-eyebrow">02 / Scope</p>
              <h2>Choose what to reset</h2>
            </div>
            <span className="reset-session-label">{hasCurrentSession ? "Current session found" : "No current session"}</span>
          </div>
          <div className="reset-scope-grid">
            {scopeCards.map((card) => (
              <label className={`reset-scope-card ${scope === card.value ? "selected" : ""}`} key={card.value}>
                <input type="radio" name="scope" value={card.value} checked={scope === card.value} onChange={() => { setScope(card.value); setConfirmation(""); setMessage(""); }} />
                <span className="reset-scope-radio" aria-hidden="true" />
                <span className="reset-scope-content">
                  <span className="reset-scope-eyebrow">{card.eyebrow}</span>
                  <strong>{card.title}</strong>
                  <span>{card.description}</span>
                  <small>{card.warning}</small>
                </span>
              </label>
            ))}
          </div>

          <div className="reset-confirmation-row">
            <label className="reset-field reset-confirmation-field">
              <span>Type this confirmation phrase</span>
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={expectedPhrase} autoComplete="off" spellCheck="false" required aria-invalid={Boolean(confirmation && confirmation !== expectedPhrase)} />
            </label>
            <div className="reset-selected-summary">
              <span>Selected scope</span>
              <strong>{selectedScope.title}</strong>
              {scope === "interaction" && hasCurrentSession ? <small>Session {sessionId.slice(0, 8)}...</small> : null}
              {scope === "interaction" && !hasCurrentSession ? <small className="reset-warning-text">Open CineMind and create an interaction session first.</small> : null}
            </div>
          </div>

          {scope === "full" ? <div className="reset-danger-note"><Warning size={18} weight="fill" aria-hidden="true" /><span>This level deletes all users and interaction data while preserving the catalog, migration history, and ops audit.</span></div> : null}
          {message ? <div className={`reset-feedback ${requestState}`} role={requestState === "error" ? "alert" : "status"}>{requestState === "error" ? <XCircle size={18} weight="fill" aria-hidden="true" /> : <CheckCircle size={18} weight="fill" aria-hidden="true" />}<span>{message}</span></div> : null}

          <div className="reset-actions">
            <p>Credentials are used for this request only.</p>
            <button className="reset-submit-button" type="submit" disabled={!canSubmit}>{requestState === "submitting" ? "Resetting..." : `Run ${selectedScope.title}`}</button>
          </div>
        </form>

        {result ? <section className="reset-result-card" aria-labelledby="result-title">
          <div className="reset-card-heading">
            <div><p className="reset-card-eyebrow">03 / Result</p><h2 id="result-title">Reset report</h2></div>
            <span className="reset-success-label">Completed</span>
          </div>
          <p className="reset-result-meta">{result.scope} / {formatResetTime(result.reset_at)}</p>
          <div className="reset-result-grid">
            {Object.entries(result.deleted_rows || {}).map(([table, count]) => <div key={table}><span>{table}</span><strong>{count}</strong></div>)}
            <div><span>Catalog</span><strong>{result.catalog_reseeded ? `${result.seeded_catalog_rows} rows reseeded` : "Preserved"}</strong></div>
          </div>
        </section> : null}

        <footer className="reset-footer"><span>Protected CineMind maintenance page</span><span>Data changes are recorded by the API response.</span></footer>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<AdminResetPage />);
