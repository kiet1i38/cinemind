import { useEffect, useState } from "react";
import { appConfig, isMovie } from "../config/appConfig";
import { translate } from "../lib/i18n";

function toneFor(record) {
  const value = `${record.id}${record.title}`.split("").reduce((total, character) => total + character.charCodeAt(0), 0);
  const tones = appConfig.poster.fallbackTones;
  return tones[value % tones.length];
}

export function PosterImage({ record, language = appConfig.languages.default, className = "", priority = false }) {
  const [source, setSource] = useState(record.posterUrl || record.posterFallbackUrl || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSource(record.posterUrl || record.posterFallbackUrl || null);
    setFailed(false);
  }, [record.id, record.posterUrl, record.posterFallbackUrl]);

  if (!source || failed) {
    const fallbackTypeKey = isMovie(record) ? "posterFallbackFilm" : "posterFallbackSeries";
    return (
      <div className={`poster-fallback ${toneFor(record)} ${className}`} role="img" aria-label={translate(language, "posterUnavailable", { title: record.title })}>
        <span className="poster-fallback-type">{translate(language, fallbackTypeKey)}</span>
        <span className="poster-fallback-title">{record.title}</span>
        <span className="poster-fallback-year">{record.releaseYear || translate(language, "notListed")}</span>
      </div>
    );
  }

  return (
    <div className={`poster-image ${className}`}>
      <img
        src={source}
        alt={translate(language, "posterAlt", { title: record.title })}
        data-poster-kind={record.posterKind || "public"}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        onError={() => {
          if (record.posterFallbackUrl && source !== record.posterFallbackUrl) {
            setSource(record.posterFallbackUrl);
          } else {
            setFailed(true);
          }
        }}
      />
    </div>
  );
}
