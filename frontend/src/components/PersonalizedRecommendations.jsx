import { ArrowClockwise } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { TitleRail } from "./TitleRail";
import { translate } from "../lib/i18n";
import { getPersonalizedRecommendations } from "../services/personalizedRecommendationService";

const MODE_LABELS = {
  cold_start: "recommendationModeColdStart",
  personalized: "recommendationModePersonalized",
  degraded_catalog_fallback: "recommendationModeCatalogFallback",
  degraded_personalized: "recommendationModeDegraded"
};

export function PersonalizedRecommendations({ userId, catalog, language, onSelect, onSignIn, refreshToken = 0 }) {
  const [algorithm, setAlgorithm] = useState("hybrid");
  const [limit, setLimit] = useState(10);
  const [attempt, setAttempt] = useState(0);
  const [request, setRequest] = useState({ status: "loading", result: null, errorKey: null });

  useEffect(() => {
    if (!userId) {
      setRequest({ status: "idle", result: null, errorKey: null });
      return undefined;
    }

    const controller = new AbortController();
    let active = true;
    setRequest({ status: "loading", result: null, errorKey: null });
    getPersonalizedRecommendations({ algorithm, limit, catalog, signal: controller.signal })
      .then((result) => {
        if (active) setRequest({ status: "ready", result, errorKey: null });
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setRequest({
          status: "error",
          result: null,
          errorKey: error.status === 401 ? "recommendationSignInAgain" : "recommendationLoadError"
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [algorithm, attempt, catalog, limit, refreshToken, userId]);

  const results = request.result?.items || [];
  const modeKey = MODE_LABELS[request.result?.mode] || "recommendationModeCatalogFallback";
  const description = request.result
    ? `${translate(language, modeKey)} ${translate(language, "recommendationDemoOnly")}`
    : translate(language, "recommendationsDescription");
  let emptyContent = null;
  if (request.status === "loading") {
    emptyContent = <p className="recommendation-empty" role="status">{translate(language, "recommendationLoading")}</p>;
  } else if (request.status === "error") {
    emptyContent = (
      <div className="recommendation-empty recommendation-error" role="status">
        <span>{translate(language, request.errorKey)}</span>
        {request.errorKey === "recommendationSignInAgain" ? (
          <button type="button" className="recommendation-retry" onClick={onSignIn}>
            {translate(language, "recommendationSignIn")}
          </button>
        ) : (
          <button type="button" className="recommendation-retry" onClick={() => setAttempt((value) => value + 1)}>
            <ArrowClockwise size={15} weight="bold" aria-hidden="true" />
            {translate(language, "recommendationTryAgain")}
          </button>
        )}
      </div>
    );
  } else if (!results.length) {
    emptyContent = <p className="recommendation-empty" role="status">{translate(language, "recommendationNoTitles")}</p>;
  }

  const headerActions = (
    <div className="recommendation-controls">
      <label className="recommendation-control">
        <span>{translate(language, "recommendationAlgorithm")}</span>
        <select value={algorithm} onChange={(event) => setAlgorithm(event.target.value)}>
          <option value="hybrid">{translate(language, "recommendationHybrid")}</option>
          <option value="popularity">{translate(language, "recommendationPopularity")}</option>
          <option value="content">{translate(language, "recommendationContent")}</option>
        </select>
      </label>
      <label className="recommendation-control recommendation-count-control">
        <span>{translate(language, "recommendationCount")}</span>
        <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
          <option value={5}>5</option>
          <option value={10}>10</option>
        </select>
      </label>
    </div>
  );

  return (
    <TitleRail
      id="personalized"
      title={translate(language, "personalizedRecommendations")}
      description={description}
      items={results}
      language={language}
      onSelect={onSelect}
      headerActions={headerActions}
      emptyContent={emptyContent}
    />
  );
}
