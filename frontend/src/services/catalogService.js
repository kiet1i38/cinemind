import { catalogConfig } from "../config/appConfig";

export const localCatalogProvider = {
  async getAll(signal) {
    const response = await fetch(catalogConfig.sourceUrl, { signal });
    if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`);
    return response.json();
  }
};

export async function loadCatalog(signal, provider = localCatalogProvider) {
  const records = await provider.getAll(signal);
  if (!Array.isArray(records)) throw new Error("Catalog response is not an array");

  const validRecords = records.filter((record) => record?.id && record?.title);
  if (!validRecords.length) throw new Error("Catalog is empty");
  return validRecords;
}
