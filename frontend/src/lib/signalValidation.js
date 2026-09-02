import { signalConfig } from "../config/appConfig";

function isStepAligned(value, rule) {
  const quotient = (value - rule.min) / rule.step;
  return Math.abs(quotient - Math.round(quotient)) < Number.EPSILON * 100;
}

function isValidNumber(value, rule, { max = false } = {}) {
  const number = Number(value);
  return Number.isFinite(number)
    && number >= rule.min
    && (!max || number <= rule.max)
    && isStepAligned(number, rule);
}

export function validateSignalInput({ rating, watchMinutes }) {
  const errors = {};
  const ratingValue = String(rating ?? "");
  const durationValue = String(watchMinutes ?? "");

  if (!ratingValue.trim()) errors.rating = "requiredField";
  else if (!isValidNumber(ratingValue, signalConfig.rating, { max: true })) errors.rating = "ratingError";

  if (!durationValue.trim()) errors.watchMinutes = "requiredField";
  else if (!isValidNumber(durationValue, signalConfig.watchMinutes)) errors.watchMinutes = "durationError";

  return errors;
}

export function isDurationLongerThanRuntime(record, watchMinutes) {
  const runtime = Number(record?.runtimeMinutes);
  const duration = Number(watchMinutes);
  return Number.isFinite(runtime) && runtime > 0 && Number.isFinite(duration) && duration > runtime;
}
