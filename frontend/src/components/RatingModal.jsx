import { Clock, Star, WarningCircle, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { appConfig, isMovie, signalConfig } from "../config/appConfig";
import { getRuntimeHelper, getRuntimeLabel, getTypeLabel } from "../lib/catalog";
import { translate } from "../lib/i18n";
import { isDurationLongerThanRuntime, validateSignalInput } from "../lib/signalValidation";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { PosterImage } from "./PosterImage";

const ratingOptions = Array.from(
  { length: Math.round((signalConfig.rating.max - Math.max(signalConfig.rating.min, 0.5)) / signalConfig.rating.step) + 1 },
  (_, index) => Number((Math.max(signalConfig.rating.min, 0.5) + index * signalConfig.rating.step).toFixed(1)),
);
const starValues = Array.from({ length: Math.round(signalConfig.rating.max) }, (_, index) => index + 1);

function ratingLabel(value, language) {
  return translate(language, "ratingStars", { value: value.toFixed(1) });
}

function StarRatingPicker({ value, language, onChange, disabled, error }) {
  const selected = Number(value);
  const selectedIndex = selected > 0 ? ratingOptions.indexOf(selected) : -1;
  const choices = ratingOptions;

  const handleKeyDown = (event) => {
    const focusedValue = Number(event.target?.dataset?.ratingValue);
    const focusedIndex = Number.isFinite(focusedValue) ? ratingOptions.indexOf(focusedValue) : -1;
    const currentIndex = focusedIndex >= 0 ? focusedIndex : (selectedIndex >= 0 ? selectedIndex : 0);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") nextIndex = Math.min(choices.length - 1, currentIndex + 1);
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = choices.length - 1;
    if (nextIndex !== currentIndex || ["Home", "End"].includes(event.key)) {
      event.preventDefault();
      onChange(String(choices[nextIndex]));
      const nextValue = choices[nextIndex];
      const focusId = Number.isInteger(nextValue)
        ? `rating-star-${nextValue - 1}-full`
        : `rating-star-${Math.floor(nextValue)}`;
      document.getElementById(focusId)?.focus();
    }
  };

  return (
    <div className="rating-star-picker" role="radiogroup" aria-label={translate(language, "ratingLabel")} aria-invalid={error ? "true" : "false"} aria-describedby="rating-helper rating-error" onKeyDown={handleKeyDown}>
      {starValues.map((fullValue, index) => {
        const halfValue = fullValue - 0.5;
        const halfChoiceIndex = ratingOptions.indexOf(halfValue);
        const fullChoiceIndex = ratingOptions.indexOf(fullValue);
        const fillWidth = selected >= fullValue ? "100%" : selected >= halfValue ? "50%" : "0%";
        return (
          <span key={fullValue} className="rating-star-cell">
            <span className="rating-star-visual" aria-hidden="true">
              <Star size={24} weight="regular" />
              <span className="rating-star-fill" style={{ width: fillWidth }}><Star size={24} weight="fill" /></span>
            </span>
            <button id={`rating-star-${index}`} type="button" className="rating-star-hit half" role="radio" aria-checked={selected === halfValue} aria-label={ratingLabel(halfValue, language)} tabIndex={selectedIndex === halfChoiceIndex || (selectedIndex < 0 && halfChoiceIndex === 0) ? 0 : -1} disabled={disabled} onClick={() => onChange(String(halfValue))} data-rating-value={halfValue}><span className="sr-only">{ratingLabel(halfValue, language)}</span></button>
            <button id={`rating-star-${index}-full`} type="button" className="rating-star-hit full" role="radio" aria-checked={selected === fullValue} aria-label={ratingLabel(fullValue, language)} tabIndex={selectedIndex === fullChoiceIndex || (selectedIndex < 0 && fullChoiceIndex === 0) ? 0 : -1} disabled={disabled} onClick={() => onChange(String(fullValue))} data-rating-value={fullValue}><span className="sr-only">{ratingLabel(fullValue, language)}</span></button>
          </span>
        );
      })}
    </div>
  );
}

export function RatingModal({ item, language, existingSignal, onClose, onSave }) {
  const [rating, setRating] = useState("");
  const [watchDuration, setWatchDuration] = useState("");
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const dialogRef = useRef(null);
  const dirtyFieldsRef = useRef({ rating: false, watchDuration: false });
  const initializedItemRef = useRef(null);

  useDialogFocus(dialogRef, onClose, { enabled: Boolean(item) });

  useEffect(() => {
    if (!item) {
      dirtyFieldsRef.current = { rating: false, watchDuration: false };
      initializedItemRef.current = null;
      return undefined;
    }
    // Hydration can finish after the modal opens. Refresh an untouched form
    // when the server-provided signal arrives, but never overwrite fields the
    // user has already edited while the modal is open.
    const isNewItem = initializedItemRef.current !== item.id;
    if (isNewItem) {
      dirtyFieldsRef.current = { rating: false, watchDuration: false };
      setRating(existingSignal ? String(existingSignal.rating) : "");
      setWatchDuration(existingSignal ? String(existingSignal.watchMinutes) : "");
      setErrors({});
      setIsSaving(false);
    } else {
      if (!dirtyFieldsRef.current.rating) setRating(existingSignal ? String(existingSignal.rating) : "");
      if (!dirtyFieldsRef.current.watchDuration) setWatchDuration(existingSignal ? String(existingSignal.watchMinutes) : "");
    }
    initializedItemRef.current = item.id;
    return undefined;
  }, [existingSignal?.rating, existingSignal?.watchMinutes, item?.id]);

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
  const handleRatingChange = (value) => {
    dirtyFieldsRef.current.rating = true;
    setRating(value);
  };
  const handleWatchDurationChange = (event) => {
    dirtyFieldsRef.current.watchDuration = true;
    setWatchDuration(event.target.value);
  };

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
            <div className="form-field">
              <label><Star size={17} weight="fill" aria-hidden="true" />{translate(language, "ratingLabel")}</label>
              <StarRatingPicker value={rating} language={language} onChange={handleRatingChange} disabled={isSaving} error={errors.rating} />
              <span id="rating-helper" className="field-helper">{translate(language, "ratingHelper", ratingErrorVariables)}</span>
              {errors.rating ? <span id="rating-error" className="field-error" role="alert"><WarningCircle size={15} aria-hidden="true" />{translate(language, errors.rating, ratingErrorVariables)}</span> : null}
            </div>
            <div className="form-field">
              <label htmlFor="watch-duration-input"><Clock size={17} weight="bold" aria-hidden="true" />{translate(language, "watchDurationLabel")}</label>
              <input id="watch-duration-input" name="watchDuration" type="number" min={signalConfig.watchMinutes.min} max={signalConfig.watchMinutes.max} step={signalConfig.watchMinutes.step} inputMode="numeric" value={watchDuration} onChange={handleWatchDurationChange} placeholder={translate(language, "watchDurationPlaceholder")} aria-invalid={Boolean(errors.watchMinutes)} aria-describedby="duration-helper duration-error" />
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
