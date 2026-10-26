// A deep import of an internal file. `exports` doesn't list the path, so
// scripts/install-test.sh expects TS2307 here.
import { requestStockSync } from "medusa-plugin-print-trail/lib/stock-request"

export { requestStockSync }
