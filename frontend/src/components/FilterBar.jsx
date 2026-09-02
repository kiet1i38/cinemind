import { Funnel, X } from "@phosphor-icons/react";
import { catalogConfig, typeFilterOptions, yearFilterOptions } from "../config/appConfig";
import { translate } from "../lib/i18n";

export function FilterBar({ language, type, setType, genre, setGenre, year, setYear, genres, resultCount, hasFilters, clearFilters, pageSize, setPageSize, pageSizeOptions }) {
  return (
    <div className="filter-bar" data-testid="filter-bar">
      <div className="filter-heading"><Funnel size={17} weight="bold" aria-hidden="true" /><span>{translate(language, "filterLabel")}</span></div>
      <label className="filter-control">
        <span>{translate(language, "allTitles")}</span>
        <select value={type} onChange={(event) => setType(event.target.value)} aria-label={translate(language, "allTitles")}>
          <option value={catalogConfig.allValue}>{translate(language, "allTitles")}</option>
          {typeFilterOptions.map((option) => <option key={option.value} value={option.value}>{translate(language, option.filterLabelKey)}</option>)}
        </select>
      </label>
      <label className="filter-control">
        <span>{translate(language, "allGenres")}</span>
        <select value={genre} onChange={(event) => setGenre(event.target.value)} aria-label={translate(language, "allGenres")}>
          <option value={catalogConfig.allValue}>{translate(language, "allGenres")}</option>
          {genres.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <label className="filter-control">
        <span>{translate(language, "allYears")}</span>
        <select value={year} onChange={(event) => setYear(event.target.value)} aria-label={translate(language, "allYears")}>
          <option value={catalogConfig.allValue}>{translate(language, "allYears")}</option>
          {yearFilterOptions.map((option) => <option key={option.value} value={option.value}>{translate(language, option.labelKey)}</option>)}
        </select>
      </label>
      {hasFilters ? (
        <label className="filter-control filter-page-size-control">
          <span>{translate(language, "pageSizeLabel")}</span>
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} aria-label={translate(language, "pageSizeLabel")}>
            {pageSizeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      ) : null}
      <span className="filter-count">{translate(language, "titleCount", { count: resultCount })}</span>
      {hasFilters ? <button type="button" className="clear-filter-button" onClick={clearFilters}><X size={15} aria-hidden="true" />{translate(language, "clearFilters")}</button> : null}
    </div>
  );
}
