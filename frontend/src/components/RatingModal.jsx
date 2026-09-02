import { Clock, Star, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { appConfig, isMovie, signalConfig } from "../config/appConfig";
import { getRuntimeHelper, getRuntimeLabel, getTypeLabel } from "../lib/catalog";
import { translate } from "../lib/i18n";
import { isDurationLongerThanRuntime, validateSignalInput } from "../lib/signalValidation";
import { PosterImage } from "./PosterImage";

export function RatingModal({ item, language, existingSignal, onClose, onSave }) {
  const [rating, setRating] = useState("");
  const [watchDuration, setWatchDuration] = useState("");
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!item) return undefined;
    setRating(existingSignal ? String(existingSignal.rating) : "");
    setWatchDuration(existingSignal ? String(existingSignal.watchMinutes) : "");
    setErrors({});
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [item, existingSignal, onClose]);

  if (!item) return null;

  const submit = (event) => {
    event.preventDefault();
    const nextErrors = validateSignalInput({ rating, watchMinutes: watchDuration });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    onSave({ rating: Number(rating), watchMinutes: Number(watchDuration) });
  };

  const durationIsLong = isDurationLongerThanRuntime(item, watchDuration);
  const ratingErrorVariables = { min: signalConfig.rating.min, max: signalConfig.rating.max, step: signalConfig.rating.step };
  const durationErrorVariables = { min: signalConfig.watchMinutes.min };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="rating-modal" role="dialog" aria-modal="true" aria-labelledby="rating-modal-heading" data-testid="rating-modal">
        <button type="button" className="modal-close" onClick={onClose} aria-label={translate(language, "close")}><X size={22} aria-hidden="true" /></button>
        <div className="modal-poster"><PosterImage record={item} language={language} className="modal-poster-image" /></div>
        <div className="modal-content">
          <p className="modal-kicker">{getTypeLabel(item, language)} <span>/</span> {getRuntimeLabel(item, language)}</p>
          <h2 id="rating-modal-heading">{translate(language, "rateHeading")}</h2>
          <p className="modal-title">{item.title}</p>
          <p className="modal-description">{translate(language, "rateDescription")}</p>
          <form onSubmit={submit} noValidate>
            <div className="form-field">
              <label htmlFor="rating-input"><Star size={17} weight="fill" aria-hidden="true" />{translate(language, "ratingLabel")}</label>
              <input id="rating-input" name="rating" type="number" min={signalConfig.rating.min} max={signalConfig.rating.max} step={signalConfig.rating.step} inputMode="decimal" value={rating} onChange={(event) => setRating(event.target.value)} placeholder={translate(language, "ratingPlaceholder", ratingErrorVariables)} aria-invalid={Boolean(errors.rating)} aria-describedby="rating-helper rating-error" />
              <span id="rating-helper" className="field-helper">{translate(language, "ratingHelper", ratingErrorVariables)}</span>
              {errors.rating ? <span id="rating-error" className="field-error" role="alert"><WarningCircle size={15} aria-hidden="true" />{translate(language, errors.rating, ratingErrorVariables)}</span> : null}
            </div>
            <div className="form-field">
              <label htmlFor="watch-duration-input"><Clock size={17} weight="bold" aria-hidden="true" />{translate(language, "watchDurationLabel")}</label>
              <input id="watch-duration-input" name="watchDuration" type="number" min={signalConfig.watchMinutes.min} step={signalConfig.watchMinutes.step} inputMode="numeric" value={watchDuration} onChange={(event) => setWatchDuration(event.target.value)} placeholder={translate(language, "watchDurationPlaceholder")} aria-invalid={Boolean(errors.watchMinutes)} aria-describedby="duration-helper duration-error" />
              <span id="duration-helper" className="field-helper">{isMovie(item) ? translate(language, "watchDurationHelperMovie") : translate(language, "watchDurationHelperTv", { episodeMinutes: appConfig.catalog.tvEpisodeRuntimeMinutes })}</span>
              {errors.watchMinutes ? <span id="duration-error" className="field-error" role="alert"><WarningCircle size={15} aria-hidden="true" />{translate(language, errors.watchMinutes, durationErrorVariables)}</span> : null}
              {!errors.watchMinutes && durationIsLong ? <span className="field-warning" role="status"><WarningCircle size={15} aria-hidden="true" />{translate(language, "durationWarning")}</span> : null}
            </div>
            <div className="modal-runtime-note">{getRuntimeHelper(item, language)}</div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={onClose}>{translate(language, "cancel")}</button>
              <button type="submit" className="primary-button">{translate(language, "saveSignal")}</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
