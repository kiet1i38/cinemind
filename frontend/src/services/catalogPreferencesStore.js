import { appConfig } from "../config/appConfig";
import { createJsonStore } from "./browserStore";

const paginationConfig = appConfig.catalog.pagination;
const pageSizeStore = createJsonStore(paginationConfig.storageKey, paginationConfig.defaultPageSize);

export const catalogPageSizeStore = {
  read() {
    const value = Number(pageSizeStore.read());
    return paginationConfig.pageSizeOptions.includes(value) ? value : paginationConfig.defaultPageSize;
  },
  write(value) {
    if (paginationConfig.pageSizeOptions.includes(value)) pageSizeStore.write(value);
  }
};
