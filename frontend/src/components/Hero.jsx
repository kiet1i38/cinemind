import { ArrowUpRight, Star } from "@phosphor-icons/react";
import { getRuntimeLabel, getTypeLabel } from "../lib/catalog";
import { translate } from "../lib/i18n";
import { PosterImage } from "./PosterImage";

export function Hero({ record, language, onRate, onMoreInfo }) {
  if (!record) return null;

  return (
    <section className="hero-shell" aria-labelledby="hero-heading">
      <div className="hero-glow" aria-hidden="true" />
      <div className="hero-inner">
        <div className="hero-copy">
          <p className="hero-eyebrow">{translate(language, "heroEyebrow")}</p>
          <h1 id="hero-heading">{translate(language, "heroTitle")}</h1>
          <p className="hero-description">{translate(language, "heroDescription")}</p>
          <div className="hero-actions">
            <button type="button" className="primary-button" onClick={() => onRate(record)}>{translate(language, "rateTitle")} <ArrowUpRight size={17} weight="bold" aria-hidden="true" /></button>
            <button type="button" className="secondary-button" onClick={() => onMoreInfo(record)}>{translate(language, "moreInfo")}</button>
          </div>
          <div className="hero-feature-meta">
            <strong>{record.title}</strong>
            <span>{getTypeLabel(record, language)}</span>
            {record.releaseYear ? <span>{record.releaseYear}</span> : null}
            <span>{getRuntimeLabel(record, language)}</span>
            <span className="hero-rating"><Star size={14} weight="fill" aria-hidden="true" />{record.rating || translate(language, "notListed")}</span>
          </div>
        </div>
        <div className="hero-art-wrap">
          <div className="hero-art-frame"><PosterImage record={record} language={language} className="hero-poster" priority /></div>
          <div className="hero-art-caption">
            <span>{translate(language, "catalogDetails")}</span>
            <strong>{record.listedIn?.[0] || getTypeLabel(record, language)}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}
