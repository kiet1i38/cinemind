export function LoadingState({ language }) {
  const isVietnamese = language === "vi";
  return (
    <main className="loading-page" aria-busy="true">
      <div className="loading-copy"><div className="skeleton-line skeleton-title" /><div className="skeleton-line skeleton-text" /><p>{isVietnamese ? "Đang chuẩn bị catalog" : "Preparing the catalog"}</p></div>
      <div className="loading-rail">{Array.from({ length: 7 }, (_, index) => <div className="skeleton-card" key={index} />)}</div>
    </main>
  );
}
