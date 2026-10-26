// medusa-plugin-print-trail/stock: run a stock sync from a store's own code
// (a job, a subscriber or a route), through the entry point every trigger
// uses. It takes the print-trail:stock lock; a held lock defers the request
// to the sweep.
export { describeStockResult, requestStockSync, type StockRequestResult } from "./lib/stock-request"
export type { StockSyncInput, StockSyncResult, StockTrigger } from "./lib/stock-flow"
