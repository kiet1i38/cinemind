import { Clock, Star, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { appConfig, isMovie, signalConfig } from "../config/appConfig";
import { getRuntimeHelper, getRuntimeLabel, getTypeLabel } from "../lib/catalog";
import { translate } from "../lib/i18n";
import { isDurationLongerThanRuntime, validateSignalInput } from "../lib/signalValidation";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { PosterImage } from "./PosterImage";

function formatRatingValue(value) {
  return Number(value).toFixed(1).replace(/\.0$/, "");
}

function RatingStar({ value, rating, language, onSelect, initialFocus = false }) {
  const numericRating = Number(rating || 0);
  const fill = Math.max(0, Math.min(1, numericRating - (value - 1)));
  const halfValue = value - 0.5;
  return (
    <span className="rating-star">
      <Star className="rating-star-icon" size={27} weight="regular" aria-hidden="true" />
      {fill > 0 ? <span className="rating-star-fill" style={{ width: `${fill * 100}%` }} aria-hidden="true"><Star size={27} weight="fill" /></span> : null}
      <button
        type="button"
        className="rating-star-hit rating-star-hit-half"
        onClick={() => onSelect(halfValue)}
        aria-label={translate(language, "ratingStarAria", { value: formatRatingValue(halfValue) })}
        aria-pressed={numericRating === halfValue}
        data-rating-value={halfValue}
        data-dialog-initial-focus={initialFocus ? true : undefined}
      />
      <button
        type="button"
        className="rating-star-hit rating-star-hit-full"
        onClick={() => onSelect(value)}
        aria-label={translate(language, "ratingStarAria", { value })}
        aria-pressed={numericRating === value}
        data-rating-value={value}
      />
    </span>
  );
}

export function RatingModal({ item, language, existingSignal, onClose, onSave }) {
  const [rating, setRating] = useState("");
  const [watchDuration, setWatchDuration] = useState("");
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const dialogRef = useRef(null);

  useDialogFocus(dialogRef, onClose, { enabled: Boolean(item) });

  useEffect(() => {
    if (!item) return undefined;
    setRating(existingSignal ? String(existingSignal.rating) : "");
    setWatchDuration(existingSignal ? String(existingSignal.watchMinutes) : "");
    setErrors({});
    setIsSaving(false);
  }, [item?.id]);

  if (!item) return null;

  const submit = async (event) => {
    event.preventDefault();
    if (isSaving) return;
    const nextErrors = validateSignalInput({ rating, watchMinutes: watchDuration });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setIsSaving(true);
    try {
      await onSave({ rating: Number(rating), watchMinutes: Number(watchDuration) });
    } catch (error) {
      setErrors({ form: error?.userMessage || "signalSaveError" });
    } finally {
      setIsSaving(false);
    }
  };

  const durationIsLong = isDurationLongerThanRuntime(item, watchDuration);
  const ratingErrorVariables = { min: signalConfig.rating.min, max: signalConfig.rating.max, step: signalConfig.rating.step };
  const durationErrorVariables = { min: signalConfig.watchMinutes.min, max: signalConfig.watchMinutes.max };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="rating-modal" role="dialog" aria-modal="true" aria-labelledby="rating-modal-heading" data-testid="rating-modal">
        <button type="button" className="modal-close" onClick={onClose} aria-label={translate(language, "close")}><X size={22} aria-hidden="true" /></button>
        <div className="modal-poster"><PosterImage record={item} language={language} className="modal-poster-image" /></div>
        <div className="modal-content">
          <p className="modal-kicker">{getTypeLabel(item, language)} <span>/</span> {getRuntimeLabel(item, language)}</p>
          <h2 id="rating-modal-heading">{translate(language, "rateHeading")}</h2>
          <p className="modal-title">{item.title}</p>
          <p className="modal-description">{translate(language, "rateDescription")}</p>
          <form onSubmit={submit} noValidate>
            <fieldset className="form-field rating-star-fieldset" aria-invalid={Boolean(errors.rating)} aria-describedby="rating-helper rating-error">
              <legend><Star size={17} weight="fill" aria-hidden="true" />{translate(language, "ratingLabel")}</legend>
              <div className="rating-star-picker" role="radiogroup" aria-label={translate(language, "ratingLabel")}>
                {Array.from({ length: 10 }, (_, index) => <RatingStar key={index + 1} value={index + 1} rating={rating} language={language} onSelect={(value) => setRating(String(value))} initialFocus={index === 0} />)}
              </div>
              <output id="rating-value" className="rating-value" aria-live="polite">
                {rating ? translate(language, "ratingValue", { value: formatRatingValue(rating) }) : translate(language, "ratingEmpty")}
              </output>
              <span id="rating-helper" className="field-helper">{translate(language, "ratingHelper", ratingErrorVariables)}</span>
              {errors.rating ? <span id="rating-error" className="field-error" role="alert"><WarningCircle size={15} aria-hidden="true" />{translate(language, errors.rating, ratingErrorVariables)}</span> : null}
            </fieldset>
            <div className="form-field">
              <label htmlFor="watch-duration-input"><Clock size={17} weight="bold" aria-hidden="true" />{translate(language, "watchDurationLabel")}</label>
              <input id="watch-duration-input" name="watchDuration" type="number" min={signalConfig.watchMinutes.min} max={signalConfig.watchMinutes.max} step={signalConfig.watchMinutes.step} inputMode="numeric" value={watchDuration} onChange={(event) => setWatchDuration(event.target.value)} placeholder={translate(language, "watchDurationPlaceholder")} aria-invalid={Boolean(errors.watchMinutes)} aria-describedby="duration-helper duration-error" />
              <span id="duration-helper" className="field-helper">{isMovie(item) ? translate(language, "watchDurationHelperMovie") : translate(language, "watchDurationHelperTv", { episodeMinutes: appConfig.catalog.tvEpisodeRuntimeMinutes })}</span>
              {errors.watchMinutes ? <span id="duration-error" className="field-error" role="alert"><WarningCircle size={15} aria-hidden="true" />{translate(language, errors.watchMinutes, durationErrorVariables)}</span> : null}
              {!errors.watchMinutes && durationIsLong ? <span className="field-warning" role="status"><WarningCircle size={15} aria-hidden="true" />{translate(language, "durationWarning")}</span> : null}
            </div>
            {errors.form ? <div className="field-error form-error" role="alert"><WarningCircle size={15} aria-hidden="true" />{translate(language, errors.form)}</div> : null}
            <div className="modal-runtime-note">{getRuntimeHelper(item, language)}</div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={onClose} disabled={isSaving}>{translate(language, "cancel")}</button>
              <button type="submit" className="primary-button" disabled={isSaving} aria-busy={isSaving}>{isSaving ? translate(language, "working") : translate(language, "saveSignal")}</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
