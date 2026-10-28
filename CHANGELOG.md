# Changelog

All notable changes to `medusa-plugin-print-trail` are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package uses [semantic versioning](https://semver.org/).

## [1.1.0] - 2026-10-28

**Upgrading.** A store that already sets `PRINT_TRAIL_BASE_URL` needs to do nothing. A store whose own startup check refuses a `PRINT_TRAIL_BASE_URL` that isn't staging, but lets an unset one through, should now treat an unset URL as production whenever `PRINT_TRAIL_CHANNEL_ID` or `PRINT_TRAIL_API_TOKEN` is set, since the plugin then connects to production.

### Changed

- **The base URL defaults to the Print Trail API, `https://api.printtrail.com`**, so a store sets only `PRINT_TRAIL_CHANNEL_ID` and `PRINT_TRAIL_API_TOKEN`. `PRINT_TRAIL_BASE_URL` (the `baseUrl` option) is now only an override, for Print Trail staging or a mock. A channel ID or token without a base URL no longer stops the plugin's module loading. The default is safe because credentials belong to one environment: a staging token, or since API 1.2.0 an unknown channel ID, is refused by production. With no credentials the plugin stays unconnected, as before.
- The settings page's setup snippet no longer lists `PRINT_TRAIL_BASE_URL`, and the settings page shows the production endpoint when none is set.

## [1.0.2] - 2026-10-27

### Fixed

- **An order confirmed in the Print Trail app after the plugin blocked it** (an address Print Trail rejected, say) is now recorded as confirmed: the block and its attention clear on the next sync. Before, such an order stayed on Needs attention.
- Orders an earlier version left in that state clear without waiting for Print Trail: the sweep re-reads each one once, if the status it last stored is past confirmation (queued, back-order or complete, say). One last stored as draft or holding clears on its next change at Print Trail, or with **Refresh from Print Trail** on its order page.
- A send or confirm retry waiting on such an order ends when the sync records the confirmation.

## [1.0.1] - 2026-10-27

### Changed

- **The README is short.** It says what the plugin does, what it needs and how to set it up. The rest is on docs.printtrail.com: the [guide](https://docs.printtrail.com/integrations/medusa/) for setting up and day-to-day use, and the [reference](https://docs.printtrail.com/integrations/medusa-reference/) for the options, rate cards, pre-orders, notifications, the developer surface and troubleshooting. The README no longer lists Print Trail API versions.
- The "Package entry points" list that 1.0.0's upgrade note refers to is now in the [reference](https://docs.printtrail.com/integrations/medusa-reference/).
- The hint under a shipping option's per-country bands points at the reference instead of the README.
- The production Print Trail API host, `https://api.printtrail.com`, is named where the plugin asks for `PRINT_TRAIL_BASE_URL`. The error for a missing base URL no longer says the host is shown in the Print Trail app, and the settings page's setup snippet uses the production host instead of staging.

## [1.0.0] - 2026-10-26

**Upgrading from 0.2.0 (and 0.1.x).** From 0.1.x, first follow 0.2.0's upgrade note below (the package was renamed). Then:

1. Run `npx medusa db:migrate`. There is one new table, `print_trail_variant`.
2. Change any import of the plugin's internal files. `medusa-plugin-print-trail/lib/stock-request` is now `medusa-plugin-print-trail/stock`, with the same names. `/lib/admin/shipping-options` and `/lib/admin/shipping-options-routes` are now `/shipping-options`: `createInput` is `printTrailShippingOptionInput`, `methodsFor` is `printTrailShippingMethods`, and `validateRateCard` is unchanged. Any other deep import no longer resolves; the README's "Package entry points" lists what can be imported. Open an issue if you need something that isn't there.
3. Nothing to do for the data. The first full stock sync (or, with the stock sync off and the plugin connected, the sweep) moves `print_trail_sku_check` and `print_trail_backorder` out of variant metadata, with 0.2.0's one-off scan of every variant's metadata and its limits (up to 50,000 variants per run, and no new page once the run has taken five minutes). Until a variant is reached, its old keys are still read, so no SKU check or backorder is lost. Each variant that carried a key gets one metadata write, which sends `product-variant.updated`: a store's own subscribers (search indexing, say) see one event per such variant. The plugin's SKU check sees them too: variants whose old check was "Couldn't check", or whose SKU has changed since, are checked again with Print Trail, and the rest make no call. Storefront code that read either key should use `allow_backorder` and `print_trail_pre_order` instead.
4. TypeScript declarations now ship, so a store's `tsc` checks its use of the plugin.

### Added

- **Sync stock now** on Settings → Print Trail runs a full stock sync at once, and says whether it ran or was deferred to the next sweep because another stock sync held the lock. It is `POST /admin/print-trail/stock-sync` and `requestPrintTrailStockSyncWorkflow`.
- Public entry points for what stores imported from internal files: `medusa-plugin-print-trail/stock` (`requestStockSync`, `describeStockResult`) and `medusa-plugin-print-trail/shipping-options` (`printTrailShippingMethods`, `validateRateCard`, `printTrailShippingOptionInput`, and the `RateCard` and `ValidationIssue` types).
- TypeScript declarations for every entry point but `/admin`, for `moduleResolution` `node16`, `nodenext` or `bundler`.

### Changed

- The package is no longer private, so it can be published to npm. The README installs it from npm (`npm install medusa-plugin-print-trail`), and `package.json` has a shorter description, a homepage and a page for reporting problems.
- **`exports` lists each entry point** instead of the `./*`, `./modules/*` and `./providers/*` patterns, so nothing else in the package can be imported (upgrade step 2).
- **SKU checks are kept in the plugin's own table**, `print_trail_variant`, and the record of the backorders the plugin turned on now keeps why it did. Variant metadata, which store routes return, no longer carries `print_trail_sku_check` or `print_trail_backorder`: only `print_trail_pre_order` (written for the storefront) and `print_trail_sku` (the SKU override) are there.
- **A variant's SKU check follows the stock sync.** With Print Trail API 1.3.0, whose stock list gives each product's status, a full stock sync brings each stored check up to date (matched, pre-order or inactive) without asking Print Trail again. A SKU Print Trail has started listing is checked again at the next sweep, which re-sends the orders waiting on it.
- The README's Print Trail API table lists 1.4.0 (test-mode channels) and 1.5.0 (GTIN lengths). Neither needs a change in the plugin.

### Fixed

- **The unmatched-SKU notice kept a deleted variant's SKU for good.** Deleting a variant or a product now deletes its SKU checks, and their SKUs leave the notice at once, from the last stock sync's list of SKUs missing from Print Trail's stock list too, unless another variant was checked with the same SKU. A full stock sync forgets any variant deleted without an event, or whose product has left the Print Trail shipping profiles. A deleted variant's SKU waits for the next full stock sync (or Sync stock now) when the variant was never checked, when a stock sync was running as it was deleted, when many variants are deleted at once and the stock lock stays busy, and in a few other narrow cases. One that 0.2.0 had listed as unmatched waits until the upgrade's one-off scan completes (upgrade step 3).
- **A variant's SKU check could stay stale**, Inactive or Not found after Print Trail had started listing the product, until the variant was saved again. The stock sync now brings it up to date (above).

## [0.2.0] - 2026-10-25

**Upgrading from 0.1.x.** The package has a new name, so the store's install and `medusa-config.ts` change:

1. Uninstall the old package and install the new one: `npm uninstall @consilience/print-trail-medusa`, then `npm install ./medusa-plugin-print-trail-0.2.0.tgz`.
2. In `medusa-config.ts`, import `printTrailOptionsFromEnv` from `medusa-plugin-print-trail/config`, set the plugin's `resolve` to `medusa-plugin-print-trail` and the fulfilment provider's `resolve` to `medusa-plugin-print-trail/providers/print-trail` (keep its `id: "print-trail"`). Change any other import from `@consilience/print-trail-medusa` (`/workflows`, `/modules/printTrail`) the same way. Then build and restart the store.
3. There are no new migrations, so `npx medusa db:migrate` is needed only when upgrading from 0.1.0 (for 0.1.1's column). Nothing stored changes: the module name, the tables, the provider id (`print-trail_print-trail`) and stored webhook secrets are as they were.
4. On Medusa 2.19 or later, 0.1.x couldn't delete variant metadata keys. The stale `print_trail_pre_order` flags and `print_trail_backorder` markers it left are deleted by the full stock syncs after the upgrade, with nothing to do: the daily `print-trail-stock-sync` run (03:00 by default) and the full sync a stock change at Print Trail starts. Those on variants the stock sync manages go in the first one; the rest are found by a one-off scan of every variant's metadata, which reads up to 50,000 variants per full sync and starts no more once the sync has run for five minutes, so a large catalogue or a slow sync takes a few. The `variant_metadata_scan` state row records its progress, with `completedAt` once it is done. A SKU override cleared in a variant's Print Trail panel on 2.19 or later is still stored and still used for that variant: open the panel on any variant whose override you cleared and clear it again.

### Changed

- **The package is renamed `medusa-plugin-print-trail`** (was `@consilience/print-trail-medusa`), following the Medusa integrations directory's `medusa-plugin-[name]` naming, and the repository is now `consilience/medusa-plugin-print-trail`. The upgrade note above lists the changes to the store's install and config.
- The plugin is licensed under the [PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0) (was `UNLICENSED`). See `LICENSE`.
- Tested on Medusa 2.22.1 as well as 2.17.2. The peer ranges are unchanged (`^2.17.2`).
- An order or an order edit with a quantity that isn't a whole number (Medusa allows them, the Print Trail API doesn't) is blocked as "over Print Trail's limits", naming the lines, and isn't sent. Before, a quantity such as 1.5 was posted and refused, and one below 1 was left out of the Print Trail order. A fractional item not sent to Print Trail also keeps the order from completing automatically.

### Fixed

- On Medusa 2.19 and later, the stock sync never removed `print_trail_pre_order` or the `print_trail_backorder` marker, and clearing a SKU override in the admin left it in place. Medusa 2.19 merges a variant's metadata update instead of replacing it, so the plugin now deletes those keys with `""`, as Medusa documents. On 2.17 and 2.18 nothing changes.
- Keys 0.1.x left behind on Medusa 2.19 and later are deleted by the full stock syncs after upgrading: a `print_trail_pre_order` flag on a variant that isn't on pre-order, and a `print_trail_backorder` marker on a variant whose backorders the plugin no longer manages (its backorder setting is left as it is). A variant that has since left the Print Trail shipping profiles, or stopped managing inventory, is found by a one-off scan of every variant's metadata. The stock lock isn't renewed, so each full sync scans at most 50,000 variants, by id from where the last one stopped, and starts no page of them once it has run for five minutes; the scan is recorded as complete only when it has read past the last variant. A cleared SKU override can't be told apart from a set one, so it stays (step 4 of the upgrade note).
- The README's storefront field advice: on Medusa 2.21 and later `+variants.metadata` is silently dropped from store product requests, but the default `*variants` returns the pre-order flag anyway.

## [0.1.1] - 2026-10-20

Run `npx medusa db:migrate` after upgrading: one new column, `print_trail_order.pre_order_fulfilments`.

### Added

- **A store-facing pre-order flag:** the stock sync writes `print_trail_pre_order` into the metadata of every variant it manages, holding Print Trail's publication date (`"YYYY-MM-DD"`) while the SKU is on pre-order, or `true` when Print Trail has no date, and deletes it once the SKU isn't. It follows Print Trail's status only, so limited pre-orders and variants whose backorders the store turned on itself carry it too. It is written only when it changes, through the same read-merge-write as the plugin's other keys, and only when Print Trail's stock rows carry a status (API 1.3.0). A full sync deletes it from a variant that has left Print Trail's profiles (tracked in the `pre_order_flagged` state row). A storefront reads it with `+variants.metadata`; what remains of a limit is the variant's available stock.
- **The pre-order's shipment email:** the plugin records each Print Trail fulfilment it sees waiting for its pre-order release (from the create and confirm responses, a confirm's shipping conflict, and every sync) in `print_trail_order.pre_order_fulfilments`, since Print Trail's `backOrderReason` is null by dispatch. An order sent before 0.1.1 is backfilled from its stored snapshot when next written, so a parcel already waiting at the upgrade still counts. A fulfilment Print Trail holds only because a product is inactive (no line on pre-order) isn't recorded. That parcel's shipment email reads "Your pre-order from order #{display_id} has shipped" (headed "Your pre-order from order #{display_id} is on its way", so a mixed order's email doesn't read as if the whole order were a pre-order) and says the pre-order was released, and its `data` has `pre_order: true` (`false` for every other parcel). `print_trail.order.dispatched` carries `was_pre_order`.

### Fixed

- `notifications.shipment: true` (and `cancelTooLate: true`) means on with the default template id. Before, `true` went out as the template id.

## [0.1.0] - 2026-10-20

First release, for Medusa `^2.17.2` (tested on 2.17.2 with Node 22) and the Print Trail API up to 1.3.0.

### Added

- **Sending:** orders with products in a Print Trail shipping profile are sent to the Print Trail API on `order.placed` (or `payment.captured`) and confirmed, with a per-order lock, stored retries and a sweep job that recovers lost events.
- **Webhooks and reconcile:** a signed `POST /hooks/print-trail` receiver that re-fetches the order, one Medusa fulfilment and shipment (with tracking and a shipment email) per dispatched Print Trail parcel, auto-complete, attention codes, and an `updated-since` reconcile job.
- **Stock and SKU checks:** stock levels synced from Print Trail on a schedule and on `stock-level-updated`, print-on-demand backorders, an unmatched-SKU list, and a SKU check on every variant and product save.
- **Cancel, amend, refund and claims:** Medusa cancels and order edits carried to Print Trail, a "cancel too late" order note and admin email, refunds and returns on the timeline, and claims, exchanges and released lines sent as `-n` Print Trail orders.
- **Admin:** a Print Trail settings page with Test connection and webhook registration, a shipping page for rate-card options, order and variant widgets, Resend, Refresh and Dismiss, and a Needs attention list.
- **Prices by country in a rate card:** an optional `countries` map gives listed destinations their own weight bands (keyed by ISO 3166-1 alpha-2 code, upper case stored as lower case, each list checked like `bands`); any other destination, or a cart with no address yet, uses `bands`. A cart heavier than the last band of the list that applies gets no price, as before, and the message names the country: `/store/shipping-options/:id/calculate` still refuses it with a 400, but adding the method and Medusa's cart refresh now get no price instead of an error, so an item that takes the cart past the limit is added and the chosen shipping method is removed (before, adding the item failed). Storefronts should treat a calculated option without an `amount` as unavailable, never as free. The shipping page lists each option's countries, read-only and collapsed, and keeps them when the default bands are edited; the plugin's update route replaces them (a country left out is removed, despite Medusa merging the option's `data`), and a `null` country is read as not listed. The edit drawer can remove a country (repairing a card one country made invalid) and refuses a new currency a country has no prices in. The guard on Medusa's own shipping-option routes checks the card as Medusa will store it, the body merged over the stored data, and refuses upper-case country codes there. Cards without `countries` behave as before.
- **Webhook secret from the Print Trail API:** Test connection stores the secret Print Trail returns when the webhook is registered (encrypted, keyed from the API token), so a merchant copies only the channel id and the token. The settings page shows where the secret comes from and offers "Rotate secret"; the previous secret is accepted for 4 hours after a change. The sweep fetches the secret again when it can't read the stored one (after a new API token), only while the channel sends to this store.
- **Print Trail API 1.2.0 (in production 2026-10-20):**
  - A 429's `Retry-After` is honoured: waited out within the retry delays, otherwise the request fails as transient at once and nothing is sent until the wait is over.
  - A 500's `reference` is kept in errors, `last_error` and the admin; a validation 422's `violations` become its detail.
  - An inactive channel (403 `channel-inactive`) is recorded as `channel_inactive` beside `auth_failed`, cleared by any success; the admin says "The Print Trail channel is inactive". A send, confirm, cancel, edit or refetch refused for access (a 401 or `channel-inactive`) waits as a pending action with that attention, costing no attempt, and runs once access returns; a cancel stays requested, so a cancelled order is still cancelled. Another 403 (an inactive team, a Standard-channel token) is a manual block with Print Trail's detail. While either refusal is recorded, the sweep and reconcile probe once per run and do nothing else.
  - An order over the input limits (255 characters for an order number, `printTrailOrderNumber` or SKU; 500 lines) is blocked `over-limits` before sending; an edit over them isn't sent.
  - The webhook URL is checked against Print Trail's rules first: one over 200 characters, with credentials or a fragment is refused; plain `http` and local, private or reserved addresses still ask first.
- **Pre-order products (Print Trail API 1.3.0, on production since 2026-10-20):** an order with pre-order products is sent and confirmed at checkout; a fulfilment waiting for its pre-order release shows as "Waiting for pre-order release", not as attention, and the in-stock parcels ship. A product that goes live before its stock arrives becomes back-order attention, found from Print Trail's stock update (the waiting orders are re-read by the next sweep). The stock sync turns backorders on for an unlimited pre-order product (marker `print_trail_backorder: "pre-order"`) and off again only where it turned them on; a limited one shows what remains of the limit as stock. The order and variant widgets show waiting fulfilments, dates and limits. Against an older Print Trail API nothing changes: a pre-order order is blocked "not fulfillable" as before.
- **Pre-orders as Print Trail API 1.3.0 shipped:**
  - Only a product going `active` counts as a release. A product set inactive while orders wait keeps them waiting at Print Trail; the waiting orders are re-read from Print Trail's stock update, the fulfilment shows "Pre-order (product not active)", and the order gets low-priority attention, `pt-pre-order-inactive`, which can be marked as resolved and stays resolved until Print Trail no longer reports it.
  - An out-of-stock back-order whose product goes back on pre-order (or inactive) is re-read from Print Trail's stock update, the only signal Print Trail sends, so its back-order attention clears within one sweep.
  - An order edit Print Trail refuses for stock (409 `stock-held`, for example past a pre-order limit) stays "Print Trail refused the order edit" with Print Trail's message, and the store's stock for those SKUs is refreshed, as after a confirm shortfall (new event `print_trail.order.stock_held`).
  - A waiting fulfilment that goes on hold is recorded as released and on hold: Print Trail may retry the warehouse send, so its attention may clear on its own.
- **Print Trail API version:** the client reads `Print-Trail-Api-Version` and the settings page shows the last one heard. Display only: every feature is still chosen by the presence of its field.
- **Print Trail's final attention codes can be marked as resolved:** `pt-returned`, `pt-fulfilment-returned`, `pt-partial` and `pt-fulfilment-failed` get Mark as resolved in the order panel and on the Needs attention page. The row remembers every final state the order showed when it was resolved (the order's and each parcel's) in a new `dismissed_attention` column (run `npx medusa db:migrate`), tied to that Print Trail order. The sync doesn't raise those again while Print Trail still reports them; another parcel or a different state is raised as usual, and each is forgotten once Print Trail no longer reports it.
- **A resolved "complete manually" stays resolved** until the order completes, instead of coming back on the next sync.
- **Rendered emails:** the shipment and cancel-too-late notifications carry `content: { subject, html, text }`, so a provider without templates sends them as they are. `template` and `data` are unchanged. A template-based provider that prefers `content` (Medusa's SendGrid provider does) uses the plugin's email unless `notifications.render` is `false`.

### Behaviour notes

- **Copy:** "Reconnect Print Trail" and Test connection now say the API token or channel ID is wrong: since Print Trail API 1.2.0 an unknown channel ID is a 401. A confirm refused with a 401 or 403 blocks on `auth-failed`, `channel-inactive` or `rejected-403` instead of `invalid`.
- **A confirm Print Trail accepts with a back-order** (an out-of-stock product in a warehouse that allows back-orders, Print Trail API 1.3.0, where an older Print Trail API refused it with a stock 409) is recorded as confirmed with `pt-fulfilment-back-order` attention and no confirm retry, and the store's stock for those SKUs is refreshed. Its attention comes from the confirm response, so it shows at once; any other confirm leaves attention to the sync, as before.
- **Adopting an order Print Trail already has confirmed keeps other flows' state.** It clears only the send path's block, attention and error. The amend flow's blocks (`no-pt-lines`, `no-pt-shipping-method`) stay, and an error stays with another flow's attention (`cancel-failed`, say). A full refund recorded before the confirm, which was the block's only trace, gets the refund flow's `refunded-not-cancelled` timeline note, and its attention unless the row already has other attention. As in the refund flow, nothing is raised once that note exists, the Medusa order is cancelled or Print Trail has finished the order.
- **A full refund of an order Print Trail has finished** (`returned`, `partial` or `failed`, as well as `complete` and `cancelled`) no longer asks for a cancel, which Print Trail can't do.
- The `print-trail-stock-shortfall` subscriber also listens to `print_trail.order.attention` (for the back-order SKUs) and `print_trail.order.stock_held`, and `print_trail.stock.changed` carries `activated_skus` (items now `active`) and `held_skus` (items on pre-order or inactive, with their status).
- `webhookSecret` (`PRINT_TRAIL_WEBHOOK_SECRET`) is optional: a fallback used only while no secret from Print Trail is stored. The stored secret wins.
- Sending reads Print Trail's `confirmedAt` and the typed duplicate-create 409 (with the order as `data`) when present: no lookup by order number after such a 409, and a `holding` order is no longer guessed at. Without them, the old logic runs. One deliberate change when `confirmedAt` is present but the 409 is untyped: an order found by number that reads `confirmedAt: null` is adopted only when Print Trail itself would count it as confirmed (`queued`, `scheduled`, `processing` or a countdown); a finished one is blocked as a conflict, as Print Trail's `order-not-updatable` says. The same holds when an order is fetched by its uuid (a Resend), so a row blocked as a conflict stays blocked.
- **A typed `order-not-updatable` 409 is read from its order** (Print Trail API 1.1.1). Since 1.1.1 a finished order answers `order-not-updatable` even if it was once confirmed. An order in the 409's `data` with `confirmedAt` set (or that Print Trail would count as confirmed: `queued`, `scheduled`, `processing` or a countdown) is adopted as confirmed and synced to its final state; one never confirmed blocks as a conflict; a cancelled one is recorded as cancelled. Only a row that lost its Print Trail uuid reaches this.
- **An adopted order is synced at once.** Adopting an order Print Trail already has confirmed schedules a sync due now (run by the next sweep) instead of clearing the send lease, so a finished order, which sends no more webhooks, gets its Medusa fulfilments and shipments and completes (or shows its attention). A lost row also records the lines Print Trail holds as the lines it sent, so the order can auto-complete and its lines are never sent again as a "-n" order.
