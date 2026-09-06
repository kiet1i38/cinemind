import { ArrowRight, LockKey, X } from "@phosphor-icons/react";
import { useRef } from "react";
import { getAuthPageUrl } from "../services/authService";
import { translate } from "../lib/i18n";
import { useDialogFocus } from "../hooks/useDialogFocus";

export function AuthRequiredModal({ language, action, title, onClose }) {
  const dialogRef = useRef(null);
  useDialogFocus(dialogRef, onClose, { enabled: Boolean(action) });

  if (!action) return null;

  const actionKey = action === "rating" ? "authRequiredForRating" : "authRequiredForPreference";
  const navigate = (mode) => {
    window.location.href = getAuthPageUrl(mode);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="auth-required-modal" role="dialog" aria-modal="true" aria-labelledby="auth-required-heading">
        <button type="button" className="modal-close" onClick={onClose} aria-label={translate(language, "close")}><X size={22} aria-hidden="true" /></button>
        <div className="auth-required-icon" aria-hidden="true"><LockKey size={22} weight="duotone" /></div>
        <p className="auth-required-kicker">{translate(language, "account")}</p>
        <h2 id="auth-required-heading">{translate(language, "authRequiredTitle")}</h2>
        <p className="auth-required-copy">{translate(language, actionKey, { title: title || "" })}</p>
        <div className="auth-required-actions">
          <button type="button" className="primary-button" onClick={() => navigate("login")} data-dialog-initial-focus>
            {translate(language, "continueToLogin")} <ArrowRight size={16} weight="bold" aria-hidden="true" />
          </button>
          <button type="button" className="secondary-button" onClick={() => navigate("register")}>
            {translate(language, "continueToRegister")}
          </button>
        </div>
        <button type="button" className="auth-required-dismiss" onClick={onClose}>{translate(language, "keepBrowsing")}</button>
      </section>
    </div>
  );
}
