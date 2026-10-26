# Print Trail for Medusa

`medusa-plugin-print-trail` is a Medusa v2 plugin that connects a Medusa store to the [Print Trail API](https://docs.printtrail.com/developers/api-documentation/).

- Orders containing Print Trail products are sent to Print Trail and confirmed automatically.
- Fulfilment progress and tracking numbers come back as Medusa fulfilments and shipments, one per Print Trail parcel, each with its own shipment email.
- Stock levels are synced from Print Trail into Medusa inventory.
- Medusa cancels, order edits, claims and exchanges are carried to Print Trail. Refunds, returns and address changes are recorded on the order's Print Trail timeline.

Print Trail: [printtrail.com](https://printtrail.com/). User guide: [docs.printtrail.com](https://docs.printtrail.com/overview/introduction/). API reference: [docs.printtrail.com/developers/api-reference](https://docs.printtrail.com/developers/api-reference/).

## Screenshots

![The Print Trail fulfilments and timeline widget on a Medusa order: one fulfilment dispatched by tracked shipping with its Royal Mail tracking number, and a timeline from sent and confirmed to completed](media/order-widget.png)

The order page: each Print Trail fulfilment with its status and tracking, and the order's Print Trail timeline.

![The Print Trail settings page: the connection shows Connected with the channel, team and Print Trail API version, and the webhook is registered with its secret from Print Trail](media/settings.png)

Settings → Print Trail: the connection to the Print Trail API, and the webhook with its secret from Print Trail.

![The Print Trail shipping page: three rate-card shipping options with their Print Trail methods and weight bands, the Europe option with its own bands for Ireland](media/shipping-rate-cards.png)

Print Trail shipping: shipping options priced by weight band, here with Ireland's own bands on the Europe option.

## Compatibility

- Medusa `^2.17.2`. Tested on Medusa 2.17.2 and 2.22.1 with Node 22.
- `engines` is `node >=20`, Medusa 2.17's own floor. Node 20 is untested. Medusa itself needs more from 2.19 (`^20.19 || >=22.12`) and from 2.22 (`>=22.22.0`).

### Print Trail API versions

Print Trail sends its API version with every response. The settings page shows the last one the store heard ("Print Trail API version"). Each feature below is used whenever Print Trail sends its field, whatever the version says; the version is only shown.

| Print Trail API | Features |
|---|---|
| 1.0.0 | Everything else in this README. |
| 1.1.0 | The webhook secret returned by webhook registration, Rotate secret, `confirmedAt` on orders, and typed duplicate-create 409s (fewer lookups by order number). |
| 1.2.0 | Production since 2026-10-20: webhook URLs must be `https` on a public host, an unknown channel ID is a 401, inactive channels and teams are refused, `Retry-After` on 429s, a `reference` on 500s, and input limits. Nothing to enable; see Troubleshooting. |
| 1.3.0 | Pre-order products (below; production since 2026-10-20): pre-order lines held and released by Print Trail, `backOrderReason` and `sentToWarehouseAt` on fulfilments, a confirm that becomes a back-order instead of a stock refusal, and pre-order status, dates and limits on stock. |
| 1.4.0 | Test-mode channels: orders and webhooks carry a `mode` of `live` or `test`, and a test channel's orders are checked and stored but never reach the warehouse, so they stay processing with no dispatch. The plugin doesn't read `mode`, so nothing changes. |
| 1.5.0 | GTINs at a consistent length (a book's is its ISBN-13, a UPC-A's its 13-digit form), with `ean` and `upc` filled in more often. The plugin doesn't read or send GTINs, so nothing changes. |

## Install

In the store:

```bash
npm install medusa-plugin-print-trail
```

Then configure the plugin (next section) and run the migrations. They create the plugin's tables and the link to orders:

```bash
npx medusa db:migrate
```

## Configure

### `medusa-config.ts`

```ts
import { printTrailOptionsFromEnv } from "medusa-plugin-print-trail/config"

const printTrail = printTrailOptionsFromEnv() // { baseUrl, channelId, apiToken }

module.exports = defineConfig({
  // …
  plugins: [{
    resolve: "medusa-plugin-print-trail",
    options: {
      ...printTrail,
      backendUrl: process.env.MEDUSA_BACKEND_URL,  // public URL, for webhook registration
      adminUrl: process.env.MEDUSA_ADMIN_URL,      // for the "view in Medusa" link sent to Print Trail
      appUrl: undefined,                    // Print Trail app base; default derived from baseUrl
      orderNumberPrefix: "SHOP-",           // Print Trail orderNumber = prefix + display_id [+ "-n"]
      defaultShippingMethod: "standard",
      confirmOn: "order.placed",            // or "payment.captured" for manual/BACS-style payments
      strictSkus: true,
      stockSync: { enabled: true },
      reconcile: { enabled: true, lookbackDays: 7 },
      autoComplete: true,
      notifications: {
        shipment: "print-trail-shipment",           // template id, or false
        cancelTooLate: "print-trail-cancel-too-late", // template id, or false
        adminEmail: process.env.PRINT_TRAIL_ADMIN_EMAIL, // shop admin address(es) for alerts
      },
      stockLocationIds: undefined,          // default: every location stocking the SKU
    },
  }],
  modules: [{
    resolve: "@medusajs/medusa/fulfillment",
    options: {
      providers: [
        { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" },
        {
          resolve: "medusa-plugin-print-trail/providers/print-trail",
          id: "print-trail",
          options: printTrail,
        },
      ],
    },
  }],
})
```

**Why two blocks.** Medusa passes a plugin's options to the modules inside the plugin. A fulfilment provider isn't one of those. It is registered under the Fulfillment Module, gets only the options given there, and can't reach the plugin's own module. So:

- the `plugins` entry configures everything else: the plugin's module, workflows, API routes, jobs and subscribers;
- the fulfilment provider entry needs only the three credentials. It lists Print Trail's shipping methods and prices options from their rate cards. It is registered with `id: "print-trail"`, so Print Trail shipping options carry `provider_id` `print-trail_print-trail`.

`printTrailOptionsFromEnv()` reads the three credentials once, so both blocks get the same values.

**Keep the manual provider listed.** Setting `providers` replaces Medusa's default list. Without the `fulfillment-manual` entry, the store's existing manual shipping options stop working. If the store already has an `@medusajs/medusa/fulfillment` entry, add the Print Trail provider to it rather than adding a second entry.

### Environment variables

The plugin itself reads only `PRINT_TRAIL_BASE_URL`, `PRINT_TRAIL_CHANNEL_ID` and `PRINT_TRAIL_API_TOKEN` (through `printTrailOptionsFromEnv()`), plus the three schedule variables below. The other names are the ones the sample config passes through, so a store may use different names.

| Variable | Option | Meaning |
|---|---|---|
| `PRINT_TRAIL_BASE_URL` | `baseUrl` | The Print Trail API host. No default (see below). |
| `PRINT_TRAIL_CHANNEL_ID` | `channelId` | The Print Trail channel for this store. |
| `PRINT_TRAIL_API_TOKEN` | `apiToken` | The channel's API token. |
| `PRINT_TRAIL_WEBHOOK_SECRET` | `webhookSecret` | Optional. Only for a Print Trail API that doesn't return the webhook secret when the webhook is registered (see "The webhook secret" below). Pass it as `webhookSecret: process.env.PRINT_TRAIL_WEBHOOK_SECRET`. |
| `MEDUSA_BACKEND_URL` | `backendUrl` | This backend's public URL. The webhook is registered at `{MEDUSA_BACKEND_URL}/hooks/print-trail`. |
| `MEDUSA_ADMIN_URL` | `adminUrl` | The Medusa admin URL. Print Trail orders link back to `{adminUrl}/orders/{id}`, and so does the cancel-too-late email. |
| `PRINT_TRAIL_ADMIN_EMAIL` | `notifications.adminEmail` | Who gets the cancel-too-late email. A comma-separated list is accepted. |

**`baseUrl` has no default**, so nothing reaches Print Trail unless someone chose a host. Use `https://printtrail-core.consilstaging.com` for staging, or the production host shown in the Print Trail app.

- With none of the three credentials set, the plugin loads as "not connected" and sends nothing.
- With a channel id or token set but no base URL, the plugin's module fails to load at startup, with a message naming the staging host.

Changing any credential needs a restart.

### Job schedules

A scheduled job's schedule is fixed when its file loads, before plugin options are available. So the schedules come from environment variables, not options:

| Variable | Job | Default |
|---|---|---|
| `PRINT_TRAIL_SWEEP_SCHEDULE` | `print-trail-sweep`: due retries, orders whose `order.placed` was missed, re-fetches, deferred stock syncs and SKU checks | `*/5 * * * *` |
| `PRINT_TRAIL_RECONCILE_SCHEDULE` | `print-trail-reconcile`: the `updated-since` poll that catches what webhooks missed | `0 */6 * * *` |
| `PRINT_TRAIL_STOCK_SCHEDULE` | `print-trail-stock-sync`: the full stock sync | `0 3 * * *` |

Set them in both the server's and the worker's environment. The settings page shows the server process's values.

### Options

Every option of the `plugins` entry, as `resolvePluginOptions` reads it:

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | none | Print Trail API host. Required once a channel id or token is set. |
| `channelId` | none | Print Trail channel id. |
| `apiToken` | none | Print Trail API token. Never logged and never returned by the admin API. |
| `webhookSecret` | none | Fallback secret for the HMAC-SHA256 `Signature` header on webhooks, used only until Print Trail has returned one (below). With neither, every webhook is refused (401). |
| `backendUrl` | none | Public URL of this backend, for webhook registration. Without it, Test connection can't register the webhook. |
| `adminUrl` | none | Medusa admin URL, for the link sent to Print Trail as `orderUrl` and the admin email's order link. |
| `appUrl` | derived | Print Trail app URL, for links into Print Trail. By default it comes from `baseUrl`: an `api.` host becomes `app.`, and any other host is used as it is. |
| `orderNumberPrefix` | `""` | Print Trail order number is prefix + Medusa `display_id`, with `-n` for the order's second and later Print Trail orders (claims, exchanges, released lines). |
| `defaultShippingMethod` | `"standard"` | Print Trail shipping method for an option whose `data` has no `method`. It is also the confirm request's default method. |
| `confirmOn` | `"order.placed"` | When the Print Trail order is confirmed. `"payment.captured"` waits for a capture (manual or bank-transfer payments). The draft is sent at placement either way. |
| `strictSkus` | `true` | Ask Print Trail to refuse the order if any SKU is unknown. The order is then blocked as `unmatched-skus` until the SKU is fixed. |
| `stockSync.enabled` | `true` | Sync stock from Print Trail: the scheduled job, `stock-level-updated` webhooks and refreshes after a stock shortfall or dispatch. Read when each run starts. |
| `reconcile.enabled` | `true` | Run the reconcile poll. Read when the job runs. |
| `reconcile.lookbackDays` | `7` | How far back the sweep looks for orders, and the reconcile poll's first window. |
| `autoComplete` | `true` | Complete the Medusa order once every Print Trail line has shipped. |
| `notifications.shipment` | `"print-trail-shipment"` | Template id for the per-parcel shipment email (`true`: the default id), or `false` for none. The plugin renders the email itself; the id is for a template-based provider (see Notifications). |
| `notifications.cancelTooLate` | `"print-trail-cancel-too-late"` | Template id for the admin email when a Medusa cancel comes too late for Print Trail (`true`: the default id), or `false` for none. Rendered by the plugin, as above. |
| `notifications.render` | `true` | Send the plugin's rendered email as `content`. `false`: `template` and `data` only, for a template-based provider such as SendGrid, which otherwise prefers `content`. |
| `notifications.adminEmail` | `[]` | Recipients of the cancel-too-late email: a list, or a comma-separated string. Empty means no email (a warning is logged). |
| `stockLocationIds` | every location | Stock locations whose levels the stock sync writes. Unset, a SKU's figure is written to every location that stocks it, with a `multi-location` warning. |

## Set up in the admin

1. **Connect.** Go to Settings → Print Trail and press **Test connection**. It checks the token and channel, saves the team code used for links into the Print Trail app, and registers this store's webhook URL, `{MEDUSA_BACKEND_URL}/hooks/print-trail`:
   - Print Trail sends webhooks only to `https://` URLs of at most 200 characters on a public host, and since Print Trail API 1.2.0 refuses to register any other (the page shows Print Trail's reason). When the URL isn't `https`, or is a local, private or reserved address, the page asks before registering it (a development Print Trail or the bundled mock accepts one); a URL over 200 characters, with a user name or password, or with a `#fragment` is never registered. A local `http://` Medusa needs an HTTPS tunnel (ngrok, Cloudflare Tunnel and the like): set `MEDUSA_BACKEND_URL` to the tunnel's address.
   - When the channel's webhook is registered at another address, the page shows "sending elsewhere" and asks before replacing it.
   - Nothing registers on page load or on a schedule.
   - Registering also fetches the channel's webhook secret from the Print Trail API and stores it, so the channel id and the API token are all a merchant copies. When the webhook is already registered here, Test connection posts the same address again to fetch the secret (Print Trail never changes it there). The page shows where the secret comes from: "From Print Trail", "From PRINT_TRAIL_WEBHOOK_SECRET" or "Not set".
2. **Shipping profile.** Create a shipping profile, for example "Print Trail", and put each Print Trail product in it. Medusa sets the profile on the product, and its variants inherit it. The plugin sends the order's items whose product is in a profile served by a Print Trail shipping option. Mixed baskets work, because Medusa asks for one shipping method per profile.
3. **Shipping option.** Create Print Trail shipping options on Settings → Print Trail → Shipping. Each option has a Print Trail method and a rate card (below).
   - **The option's fulfilment set must be linked to a stock location.** Otherwise the plugin can't create Medusa fulfilments when Print Trail dispatches.
   - With managed inventory, the item needs a reservation, which Medusa makes at checkout when the variant has an inventory level at a location the sales channel uses.
4. **SKUs.** A variant is matched to Print Trail by its SKU, case-insensitively. When Print Trail's SKU differs, set the variant metadata key `print_trail_sku` (the Print Trail panel on the variant page edits it). Saving a variant or moving a product into a Print Trail profile checks the SKU with Print Trail. Settings → Print Trail lists unmatched SKUs. A SKU is unmatched when Print Trail's stock list doesn't have it; a sold-out product is still listed, with 0. Print Trail's stock list also includes inactive products without marking them, so a variant matched to an inactive Print Trail product counts as matched and its stock is synced. The variant's SKU check shows it as Inactive, and Print Trail may refuse orders for it at confirm.
   - **Sync stock now** on the same page runs a full stock sync at once, as the daily job does, and says whether it ran or was deferred: while another stock sync holds the lock, the request waits for the next sweep. With Print Trail API 1.3.0, whose stock list gives each product's status, a full stock sync also brings each variant's SKU check up to date (matched, pre-order or inactive), and a SKU Print Trail has started listing is checked again at the next sweep, which re-sends the orders waiting on it.
   - Deleting a variant or a product removes its SKU checks, and their SKUs leave the unmatched list at once, unless another variant was checked with the same SKU. A deleted variant's SKU stays until the next full stock sync when the variant was never checked, when a stock sync was running as it was deleted, when many variants are deleted at once and the stock lock stays busy, and in a few other narrow cases. After an upgrade from 0.2.0, a SKU that 0.2.0 had listed as unmatched stays until the upgrade's one-off scan of variant metadata completes (the CHANGELOG's upgrade note). **Sync stock now** clears it straight away, once no other stock sync is running.

### The webhook secret

Print Trail signs every webhook with the channel's secret. The plugin gets it from the Print Trail API, as the response to registering the webhook (`POST /webhooks`), and stores it in `print_trail_state`, encrypted with a key derived from the API token. It never reaches the browser or a log.

- **Precedence:** the stored secret wins. `PRINT_TRAIL_WEBHOOK_SECRET` is used only while nothing is stored, which happens with a Print Trail API that doesn't return the secret yet. When both are set and differ, the settings page warns; remove the variable or update it. The two are never both accepted, so a secret that has been replaced stops working.
- **Rotating:** "Rotate secret" on the settings page asks Print Trail for a new secret and stores it. It is offered only while the channel sends its webhooks to this store. Deliveries Print Trail queued before the rotation are still signed with the old secret, so the old one is accepted for 10 more minutes. A delivery refused after that is caught up by the reconcile poll.
- **Rotated in the Print Trail app** (Settings → Channels, "Webhook secret"): webhooks are refused until someone presses Test connection, which fetches the new secret. The old one is accepted for 4 hours from then.
- **A new API token** makes the stored secret unreadable. The sweep fetches it again on its next run while the channel sends to this store (it never registers elsewhere); Test connection does the same at once.

### Rate cards

Each Print Trail shipping option stores its method and rate card in its `data`:

```json
{
  "method": "tracked",
  "currency_code": "gbp",
  "bands": [
    { "max_weight": 1000, "prices": { "gbp": 3.95 } },
    { "max_weight": null, "prices": { "gbp": 6.5 } }
  ]
}
```

- **One currency per option.** Medusa's price calculation passes no currency to the provider, so the card names its own `currency_code`. A store selling in two currencies makes one option per currency. Each band's `prices` is keyed by currency and must include the card's `currency_code`. Prices in other currencies may sit alongside, and the shipping page keeps them.
- **Weights are in grams**, as Medusa stores them. `max_weight` is an inclusive upper limit. Bands must ascend, and only the last may be `null` (no limit).
- **Weight fallback.** A variant with no weight uses its product's weight. A weight of `0` is a real weight and is not replaced.
- **Prices** are major units, stored as entered (`3.95` is £3.95).
- **Validation.** `method` must be one the channel offers (`GET /shipping-methods`), or one of `standard`, `express`, `air` or `tracked` when Print Trail can't be reached. Cards are validated on the plugin's shipping page and on Medusa's own `/admin/shipping-options` routes.

#### Prices by country

A card can price some destinations differently. `countries` maps a country code to that country's own bands; any destination not listed, or a cart with no shipping address yet, uses `bands`:

```json
{
  "method": "standard",
  "currency_code": "gbp",
  "bands": [
    { "max_weight": 250, "prices": { "gbp": 17.5 } },
    { "max_weight": 2000, "prices": { "gbp": 41.5 } }
  ],
  "countries": {
    "fr": [
      { "max_weight": 250, "prices": { "gbp": 8.25 } },
      { "max_weight": 2000, "prices": { "gbp": 20 } }
    ]
  }
}
```

- **The destination** is the cart's shipping address country. One option can then serve a whole region, rather than one option and service zone per price.
- **Codes** are ISO 3166-1 alpha-2, as Medusa lists them (`gb`, not `uk`). Upper-case codes are accepted, and the plugin's routes store them in lower case. An unknown code, or the same code twice in different cases, is refused. Medusa's own `/admin/shipping-options` routes store the card as sent, so they refuse an upper-case code: Medusa would keep it beside a stored lower-case one.
- **Each country's bands** follow the same rules as `bands`: ascending, only the last may be `null`, and every band needs a price in the card's `currency_code`.
- **A weight limit applies per country.** A cart heavier than the last band of the list that applies gets no price, so checkout can't offer the option. A country's last band caps it even when the default bands go higher. Over the limit:
  - `POST /store/shipping-options/:id/calculate` answers 400 (`not_allowed`, "No standard rate for 2400 g to France in GBP"), so a storefront that leaves out options it can't price never shows it.
  - Adding the option as the cart's shipping method is refused (400, "do not have a price").
  - If the cart already has the option and an added item takes it over the limit, the item is added and Medusa removes the shipping method; the customer chooses again.
  - **Storefronts should treat a calculated option without an `amount` as unavailable, never as free.** A storefront that reads a missing amount as 0 would offer it for nothing.
- **The shipping page** lists each option's countries, collapsed, and keeps them when you edit the option. The edit drawer can remove a country, which is also how to clear one the card can't accept (a card shown as invalid). It doesn't edit a country's bands, and it refuses a new currency that some country has no prices in: for either, send the whole card, `countries` included, to `POST /admin/print-trail/shipping-options/:id`. That replaces the card, so a country left out is removed. Medusa's own `/admin/shipping-options/:id` merges the body's `data` into the stored card (objects key by key, arrays and `null` replaced), so it can add one country with `{ "countries": { "de": [...] } }` and remove one by sending it as `null` under exactly the code the card stores (a `null` naming no stored code is refused, since it would remove nothing); a `null` country is read as not listed. The plugin checks the card as it will be after that merge, so a change that would leave it invalid (a new `currency_code` that a listed country has no prices in, say) is refused.

### Needs attention

An order that needs a person shows an attention flag in the order's Print Trail panel and on the Needs attention page. Most flags clear themselves: a send block clears when the order sends, a retry flag on Resend, and a Print Trail state on the next sync that no longer shows it. **Mark as resolved** clears the ones nothing else will, such as a dispatch mismatch, "complete manually", a cancel that came too late, or a refund Print Trail may still ship.

Print Trail's final states can be marked as resolved too: returned (`pt-returned`), part returned (`pt-fulfilment-returned`), partly dispatched (`pt-partial`) and a failed fulfilment (`pt-fulfilment-failed`). Print Trail won't change these, so once you have dealt with one, the sync doesn't raise it again. Resolving one resolves every final state the order shows at that moment, so a returned order's returned parcels, or a partial order's failed parcel, aren't flagged next. Anything that reaches a final state later is still flagged: another parcel that fails or is returned, or the whole order returned after a part return. A higher flag that comes and goes, such as a hold, doesn't bring a resolved parcel back. Once Print Trail no longer reports a resolved state, the plugin forgets it, so it is flagged again if it ever comes back. The memory belongs to the Print Trail order: if the order is re-sent as a different Print Trail order, it starts afresh. A pre-order waiting on a product that isn't active at Print Trail (`pt-pre-order-inactive`) can be marked as resolved the same way, on its own: resolving it doesn't resolve a final state, nor the reverse.

"Complete manually" also stays resolved while the order still needs completing by hand, and is forgotten once the order completes. Marking as resolved never changes anything at Print Trail, and each one is noted on the order's timeline.

## Pre-order products

Pre-order support needs Print Trail API 1.3.0 (on production since 2026-10-20). With an older Print Trail API, an order containing a pre-order product is blocked "not fulfillable" and must be sent again by hand after release (Resend), or held back with a `filterLines` handler until then.

With 1.3.0:

- **Sent at checkout.** The order is sent and confirmed as usual. Print Trail holds the pre-order lines in a fulfilment of their own. The order shows a blue "Pre-order" badge and the fulfilment reads "Waiting for pre-order release" (with the expected date when Print Trail has one). That is not an attention state.
- **The rest ships.** In a mixed order the in-stock parcels ship as normal. Print Trail releases the waiting part when the product goes live, and the order completes when the last parcel ships.
- **Live before the stock arrives.** The waiting fulfilment becomes an ordinary back-order ("Back-order: out of stock at Print Trail"), which is attention. Print Trail signals this only through its stock update, which it batches over up to ten minutes; the next sweep then re-reads the order, so it usually shows within 15 minutes. If the product is then put back on pre-order, the fulfilment waits for the release again and the attention clears the same way.
- **Only going live releases.** A product made inactive at Print Trail while orders wait keeps them waiting there, whatever stock arrives, until it is made active. The fulfilment reads "Pre-order (product not active)" and the order gets a low-priority flag, "A pre-order product isn't active at Print Trail, so the order waits". Mark it as resolved if that's expected; it stays resolved until Print Trail no longer reports it.
- **Held after release.** When Print Trail can't reach the warehouse to send a released fulfilment, it holds it, and may try again for up to an hour (a refusal from the warehouse waits for someone at Print Trail). The order shows "A fulfilment is holding at Print Trail" meanwhile, and the flag may clear on its own.
- **Stock.** For an unlimited pre-order product, the stock sync turns backorders on (so it can be bought at 0 stock) and turns them off again once the product goes live, but only where the plugin turned them on: a backorder flag the store set itself is left alone. A pre-order product with a limit has what remains of the limit as its available stock, with backorders off, so the store stops selling at the limit. (Print Trail's remaining figure already counts the confirmed pre-orders, so the stock written adds back Medusa's own reservations for them.) With several stock locations, the allowance goes to one level only (Medusa adds availability up across locations): set `stockLocationIds` to choose it, or the plugin uses the first location by id. The variant page shows the pre-order status, the expected date, and the limit with what's left.
- **In the storefront.** The stock sync writes `print_trail_pre_order` into the metadata of every variant it manages: Print Trail's publication date (`"2027-03-04"`) while the product is on pre-order, or `true` when Print Trail has no date, and nothing once it isn't. It follows Print Trail's status alone, so a limited pre-order and a variant whose backorders the store turned on itself carry it too. Variant metadata is public on store routes: the store product routes' default fields (`*variants`) return it, as does a cart's `*items.variant`, so a storefront that keeps the default fields already has it, and shows its pre-order badge, button and date from it. From Medusa 2.21 a store route silently drops a requested field that isn't on its allowed list, and `variants.metadata` isn't on the product routes' list: `+variants.metadata` is harmless but adds nothing, and a field list that replaces the defaults (fields without `+` or `*`) must include `*variants`. Alternatively the store allows the field itself with `allowFields("variants.metadata")` from `@medusajs/framework/http`, in a middleware with `matcher: "/store/products*"` and no `method` (a method-scoped middleware runs after the query is checked). What remains of a limit needs no field of its own: it is the variant's available stock (`inventory_quantity`). The flag is written by the stock sync, so it follows a status or date change at Print Trail within a webhook-driven sync (the change sends `stock-level-updated`, which runs one; the daily run catches a missed webhook), only for variants with managed inventory in a Print Trail shipping profile; a variant that leaves those loses it at the next full sync. It needs Print Trail API 1.3.0: with an older API the flag is left as it is.
- **The pre-order's parcel email.** The shipment email for the released parcel says so: "Your pre-order from order #{display_id} has shipped" (Notifications, below). In a mixed order the in-stock parcel gets the ordinary email first.
- **Edits and cancels.** While the pre-order part waits at Print Trail, the order can still be edited and cancelled (a cancel is immediate). Once Print Trail has sent any part to the warehouse, edits are refused as for any order in progress, and a cancel goes through the warehouse. An edit past a pre-order limit (or past stock held by other orders) is refused with Print Trail's message, and the store's stock for those SKUs is refreshed.
- **Back-order warehouses.** A confirm for an active product Print Trail has none of, in a warehouse that allows back-orders, is accepted as a back-order: the order is confirmed with back-order attention, no retry, and the store's stock for those SKUs is refreshed.

## Notifications

Both emails go through Medusa's Notification Module, so the store needs a notification provider on the `email` channel (for example SendGrid, Resend or `@medusajs/medusa/notification-local` for testing).

**The plugin renders both emails.** Each notification carries `content: { subject, html, text }`, plain-styled, with every value HTML-escaped and only `http(s)` URLs made into links. A provider that sends `content` (an SMTP or Resend provider, say) needs nothing more: the store doesn't supply templates. Each notification also carries `template` (the ids below, the options' defaults) and `data` (below), for a store that renders its own. Medusa's SendGrid provider sends `content` whenever it is present and ignores the template, so a store with its own SendGrid templates sets `notifications.render: false`: the plugin then sends `template` and `data` only, and SendGrid uses the template with that id. Set an email's option to `false` to turn it off. Medusa doesn't store `content` with the notification, so a notification resent from Medusa later carries only `template` and `data`.

**`print-trail-shipment`** (`notifications.shipment`). One email per dispatched Print Trail parcel, to the order's email, sent only for fulfilments the plugin created and only once a tracking number exists. Tracking that arrives later is emailed then. The plugin's email: "Your order #{display_id} is on its way", the carrier, the items in the parcel and the tracking links. A parcel that waited at Print Trail for its pre-order release is worded as the pre-order: "Your pre-order from order #{display_id} has shipped", headed "Your pre-order from order #{display_id} is on its way", "Your pre-order from order #{display_id} has been released and dispatched by {carrier}." (`pre_order: true`). The plugin knows a parcel waited because it records each Print Trail fulfilment it sees waiting for release (from the create and confirm responses and every sync), since by dispatch Print Trail no longer says so. The template receives:

```ts
{
  order: { id: string, display_id: number | string | null },
  print_trail_order_number: string | null,
  carrier: string | null,
  items: { line_item_id: string | null, title: string | null, quantity: number }[],
  tracking: { number: string, url: string | null }[],
  pre_order: boolean, // the parcel waited for its pre-order release
}
```

**`print-trail-cancel-too-late`** (`notifications.cancelTooLate`). Sent when an order is cancelled in Medusa but Print Trail has already dispatched some or all of it. One email goes to each `notifications.adminEmail` address, and the order also gets a timeline note and the `cancel-too-late` attention flag. The plugin's email: "Order #{display_id} was cancelled but has already shipped" (the order id without a display id), the Print Trail order number linked into the Print Trail app, what happened, each fulfilment with its status and tracking (or "no tracking"), the next step (contact the customer, then refund or arrange a return), and links to the order in Medusa and in Print Trail. The template receives:

```ts
{
  order: { id: string, display_id: number | string | null },
  print_trail_order_number: string,
  pt_url: string | null,          // the order in the Print Trail app
  admin_order_url: string | null, // null without adminUrl
  why: "dispatched" | "complete" | "partial",
  fulfilments: {
    number: string | null,
    status: string,
    tracking: { number: string, url: string, carrier: string | null }[],
  }[],
}
```

Medusa refuses to cancel an order that has live fulfilments, or once it is completed. So "cancel too late" arises only in the gap between Print Trail dispatching and the plugin creating the Medusa fulfilment. After that, use Medusa's return flow.

A failed email is logged and not retried.

## Production checklist

Apply this to any store before taking live orders.

- **Use Redis locking if you run more than one process.** A separate server and worker count as two. The plugin's per-order lock is what stops two processes sending one order twice, or creating duplicate fulfilments, shipments and emails. Medusa's default lock is in-memory, which works within one process only. A run with two processes and no shared lock posted one order twice. Register the Redis locking provider:

  ```ts
  modules: [
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/locking-redis",
            id: "locking-redis",
            is_default: true,
            options: {
              redisUrl: process.env.LOCKING_REDIS_URL,
            },
          },
        ],
      },
    },
  ]
  ```

  The Postgres locking provider is unsupported: it never reclaims an expired lock with no owner, and its insert race lets two holders through. The plugin checks the locking provider at startup. It logs an error for the Postgres provider, and the settings page warns when locking is in-memory or Postgres.

  With Redis locking, a lock held by a process that stops mid-run (a restart or a crash) stays until it expires, and that work waits until then: the SKU check for up to 5 minutes, an order's sends and updates for up to 10, and the stock sync for up to 15. Nothing is lost: queued SKU checks, the order and any stock sync requested meanwhile run once the lock has expired.
- **Use a Redis event bus** (`@medusajs/medusa/event-bus-redis`). The in-memory bus can drop events across restarts. The sweep finds orders whose `order.placed` never arrived, but only within `reconcile.lookbackDays`.
- **Switch payments and Print Trail credentials together.** Live payments with staging credentials send real orders nowhere. Test payments with production credentials send test orders to be made.
- **Clear or cancel test orders first.** The sweep sends any uncancelled order with Print Trail lines and no Print Trail order from the last `reconcile.lookbackDays` days. Test orders left open when production credentials go in will be sent.
- **Set `PRINT_TRAIL_ADMIN_EMAIL`**, so someone hears about a cancel that came too late.
- **Register the webhook** with Test connection on the production backend URL. Check that the settings page shows the webhook secret "From Print Trail". Only if it says "Not set" (a Print Trail API that doesn't return the secret yet) copy the production channel's secret from the Print Trail app into `PRINT_TRAIL_WEBHOOK_SECRET` and restart.
- **Admin access.** The plugin has no permissions of its own. Any admin user can use its pages and admin routes.

## Developer surface

### Package entry points

| Import | What it holds |
|---|---|
| `medusa-plugin-print-trail/config` | `printTrailOptionsFromEnv`, `resolvePluginOptions` and the option types, for `medusa-config.ts`. |
| `medusa-plugin-print-trail/providers/print-trail` | The fulfilment provider, for the fulfilment module's `providers`. |
| `medusa-plugin-print-trail/modules/printTrail` | The module (`PRINT_TRAIL_MODULE`, and `linkable` for links of your own). |
| `medusa-plugin-print-trail/workflows` | The workflows, their ids and the hook input types (below). |
| `medusa-plugin-print-trail/stock` | `requestStockSync`, the entry point every stock trigger uses (it takes the stock lock, and a held lock defers the request to the sweep), and `describeStockResult`. |
| `medusa-plugin-print-trail/shipping-options` | `printTrailShippingMethods`, `validateRateCard` and `printTrailShippingOptionInput`, to create Print Trail shipping options from a script. |
| `medusa-plugin-print-trail/admin` | The admin extensions, for Medusa's admin build. |
| `medusa-plugin-print-trail/package.json` | The package's own `package.json`. |

`medusa-plugin-print-trail/.medusa/server/src/modules/printTrail` is also exported, because Medusa loads the module from that path; don't import it. Nothing else in the package can be imported: a file that isn't listed here can change in any release.

TypeScript declarations ship for every entry point but `/admin`. They resolve with `moduleResolution` `node16`, `nodenext` or `bundler`, not `node10`, which can't resolve Medusa's own subpaths either.

A store's own job asking for a SKU-only sync, and a script creating a Print Trail shipping option:

```ts
// src/jobs/refresh-new-titles.ts
import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { describeStockResult, requestStockSync } from "medusa-plugin-print-trail/stock"

export default async function refreshNewTitles(container: MedusaContainer) {
  const result = await requestStockSync(container, { trigger: "schedule", skus: ["9781234567897"] })
  container.resolve(ContainerRegistrationKeys.LOGGER).info(`New titles' stock: ${describeStockResult(result)}`)
}

export const config = { name: "refresh-new-titles", schedule: "0 * * * *" }
```

```ts
// src/scripts/create-print-trail-option.ts: npx medusa exec ./src/scripts/create-print-trail-option.ts
import type { ExecArgs } from "@medusajs/framework/types"
import { createShippingOptionsWorkflow } from "@medusajs/medusa/core-flows"
import {
  printTrailShippingMethods,
  printTrailShippingOptionInput,
  validateRateCard,
} from "medusa-plugin-print-trail/shipping-options"

export default async function createPrintTrailOption({ container }: ExecArgs) {
  const { codes } = await printTrailShippingMethods(container)
  const checked = validateRateCard(
    { method: "tracked", currency_code: "gbp", bands: [{ max_weight: 1000, prices: { gbp: 3.95 } }, { max_weight: null, prices: { gbp: 6.5 } }] },
    codes
  )
  if (!checked.ok) throw new Error(checked.issues.map((i) => `${i.path}: ${i.message}`).join("; "))
  const option = printTrailShippingOptionInput(
    { name: "Print Trail Tracked", service_zone_id: "serzo_…", shipping_profile_id: "sp_…" },
    checked.card
  )
  await createShippingOptionsWorkflow(container).run({ input: [option] })
}
```

`printTrailShippingMethods` lists the shipping methods Print Trail offers the channel (`source: "fallback"` and a built-in list when it can't be reached). `printTrailShippingOptionInput` gives a calculated option with the Print Trail provider, the card as its data, and the store rules Medusa's own form sets.

### Where the plugin keeps its data

The plugin's records are in its own tables: its Print Trail orders and their timelines in `print_trail_order` and `print_trail_order_event`; the connection's state (the team code and the webhook secret, among others), the stock sync's bookkeeping (which backorders it turned on, and why) and the SKU check queue in `print_trail_state`; and each variant's SKU check in `print_trail_variant`. Variant metadata holds only `print_trail_pre_order`, which the stock sync writes for the storefront (Pre-order products, above), and `print_trail_sku`, the SKU override, which the plugin reads.

### Workflows

All exported from `medusa-plugin-print-trail/workflows`:

| Workflow | What it does |
|---|---|
| `sendOrderToPrintTrailWorkflow` | Sends an order's Print Trail lines as a draft, then confirms it when the gate allows. Input: `{ order_id, sequence?, source_ref?, reissue_of?, lock_timeout? }`. |
| `syncPrintTrailOrderWorkflow` | Re-fetches a Print Trail order and applies it: status, one Medusa fulfilment and shipment per dispatched parcel, completion, attention. |
| `cancelPrintTrailOrderWorkflow` | Carries a Medusa cancel to Print Trail. |
| `amendPrintTrailOrderWorkflow` | Carries an order edit to Print Trail (`PUT …/lines` once confirmed, a re-sent draft before). |
| `recordPrintTrailOrderChangeWorkflow` | Records an address change, refund or return on the timeline. |
| `syncPrintTrailStockWorkflow` | Syncs stock levels from Print Trail. It fails while another stock sync holds the lock; `requestPrintTrailStockSyncWorkflow` and `requestStockSync` (`/stock`) defer instead. |
| `requestPrintTrailStockSyncWorkflow` | Sync stock now: a full sync, or only `{ skus }`, through `requestStockSync`. Its result's `status` is `completed`, `deferred` (to the next sweep), `disabled` or `failed`. |
| `testPrintTrailConnectionWorkflow` | Test connection. |
| `registerPrintTrailWebhookWorkflow` | Registers the webhook URL. |
| `resetPrintTrailRetryWorkflow` | Resets a capped retry (used by Resend). |
| `dismissPrintTrailAttentionWorkflow` | Clears an attention code an admin has dealt with. A final Print Trail code, or complete-manually, stays dismissed while it still applies. |

`runPrintTrailFollowUps` is also exported. Each workflow's id is exported as `<name>Id`.

### Hooks

Register hook handlers in the store, for example in `src/workflows/hooks/print-trail.ts`. Each hook takes one handler.

**`filterLines`** holds lines back, for example unreleased pre-orders. It receives `{ order, lines, sequence, source_ref }` and returns `{ lines }`. Each line is `{ lineItemId, sku, quantity, method }`. **Register the same handler on both workflows**, or an order edit will send the lines the send held back:

```ts
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  amendPrintTrailOrderWorkflow,
  sendOrderToPrintTrailWorkflow,
  type FilterLinesHookInput,
} from "medusa-plugin-print-trail/workflows"

const holdUnreleased = async ({ order, lines }: FilterLinesHookInput) => {
  const released = (itemId: string) => {
    const item = order.items?.find((i) => i?.id === itemId)
    const date = item?.variant?.metadata?.release_date
    return typeof date !== "string" || new Date(date) <= new Date()
  }
  return new StepResponse({ lines: lines.filter((l) => released(l.lineItemId)) })
}

sendOrderToPrintTrailWorkflow.hooks.filterLines(holdUnreleased)
amendPrintTrailOrderWorkflow.hooks.filterLines(holdUnreleased)
```

Held lines are recorded on the order's Print Trail row. To send them once released, run `sendOrderToPrintTrailWorkflow` with just `{ order_id }`. Before the first Print Trail order is confirmed, that re-sends it with the released lines. After, it sends them as a new `-n` order. The plugin doesn't release lines on its own. The sweep only re-checks orders within `reconcile.lookbackDays`, so a store with longer pre-orders needs its own release job (a scheduled job that runs the workflow for orders whose lines are now released).

**`orderNumber`** changes the order number of a new Print Trail order. It receives `{ order, sequence, source_ref, orderNumber }`, where `orderNumber` is the default, and returns `{ orderNumber }` or a string. An empty value, one over 100 characters, or one another Print Trail order of the same Medusa order already has falls back to the default, with a warning.

```ts
sendOrderToPrintTrailWorkflow.hooks.orderNumber(async ({ order, sequence }) =>
  new StepResponse({ orderNumber: `WEB-${order.display_id}${sequence > 1 ? `-${sequence}` : ""}` })
)
```

**`payload`** is a last chance to change the create request. It receives `{ order, sequence, source_ref, payload }` and returns `{ payload }` or the fields themselves. Only `shippingDetails`, `purchaseOrder`, `printTrailOrderNumber` and `orderUrl` are taken from the result. The plugin's order number, lines, uuid and flags always win.

```ts
sendOrderToPrintTrailWorkflow.hooks.payload(async ({ order, payload }) =>
  new StepResponse({ payload: { ...payload, purchaseOrder: String(order.metadata?.po_number ?? "") || undefined } })
)
```

### Events

Emitted on Medusa's event bus. The `print_trail.order.*` events except `copy_seen` carry `{ order_id, print_trail_order_id, pt_uuid }`, plus the fields shown.

| Event | When |
|---|---|
| `print_trail.order.sent` | A draft was created in Print Trail. |
| `print_trail.order.confirmed` | The Print Trail order was confirmed. |
| `print_trail.order.blocked` | Sending or confirming was refused (`reason`, for example `unmatched-skus` or `stock-shortfall`). |
| `print_trail.order.dispatched` | A Print Trail parcel was dispatched and recorded in Medusa: `{ pt_fulfilment_uuid, fulfillment_id, was_pre_order }` (`was_pre_order`: it waited for its pre-order release). |
| `print_trail.order.cancelled` | The Print Trail order was cancelled. |
| `print_trail.order.attention` | The order needs attention (`attention`, the code). |
| `print_trail.order.stock_held` | Print Trail refused an order edit for stock (`skus`). The plugin refreshes those SKUs' stock. |
| `print_trail.order.copy_seen` | A webhook named a Print Trail copy of a known order (`{orderNumber}-COPY`): `{ order_id, print_trail_order_id, copy_uuid, copy_order_number }`. |
| `print_trail.webhook.received` | A signed order webhook for a known order was accepted: `{ order_id, print_trail_order_id, notification_type }`. The plugin re-fetches the order on it. |
| `print_trail.stock.changed` | A `stock-level-updated` webhook was accepted: `{ changed_at, activated_skus, held_skus }` (the SKUs now active, and those on pre-order or inactive with their status). The plugin runs a stock sync on it and re-reads the orders whose waiting fulfilments those changes move. |

### Jobs

`print-trail-sweep`, `print-trail-reconcile` and `print-trail-stock-sync`. See [Job schedules](#job-schedules).

### API routes

The webhook receiver is `POST /hooks/print-trail`. It checks the HMAC-SHA256 of the raw body against the `Signature` header and fails closed (401). A valid delivery gets a 202 at once. The plugin then re-fetches the order from Print Trail and never applies the webhook body itself.

Admin routes, all under `/admin/print-trail`:

| Route | Methods | Purpose |
|---|---|---|
| `connection` | GET, POST | Connection status; Test connection. |
| `webhook` | POST | Register the webhook (`{ force: true }` after the page's question). |
| `webhook/rotate` | POST | Rotate the webhook secret (only while the channel sends here). |
| `shipping-options` | GET, POST | List and create Print Trail shipping options. |
| `shipping-options/:id` | POST, DELETE | Update and delete one. A `rate_card` replaces the stored card, `countries` included. |
| `orders/:id` | GET | The order's Print Trail rows, fulfilments and timeline. |
| `orders/:id/refresh` | POST | Re-fetch from Print Trail. |
| `orders/:id/resend` | POST | Resend or retry, including "Resend as a new Print Trail order". |
| `orders/:id/dismiss` | POST | Clear an attention code (Mark as resolved). |
| `attention` | GET | Orders that need attention. |
| `sku-health` | GET | Unmatched SKUs and the last stock run. |
| `stock-sync` | POST | Sync stock now. Takes no body; returns `{ status, summary }`. |
| `variants/:id` | GET | A variant's SKU check. |

## Troubleshooting

- **`medusa db:migrate` hangs after "Running migrations...".** A Unix-socket `DATABASE_URL` such as `postgres:///db?host=/var/run/postgresql` causes it. Use a password over TCP: `postgres://user:password@127.0.0.1:5432/db`.
- **A new store from `create-medusa-app@2.17.2` breaks.** It produces a template for a newer Medusa. Its `react-router-dom` is covered by the next item; also:
  - remove the `configureStoreSearch` store-search middleware from `src/api/middlewares.ts`;
  - remove the `Modules.SEARCH` step from the seed script.
- **Every plugin link in the admin crashes with a null router context.** The admin bundler leaves `react-router-dom` to the store, so the store's copy must have the dashboard's major version: 6.x on Medusa 2.17 and 2.18 (pin `6.30.4`; a `create-medusa-app@2.17.2` store starts on 7.x), 7.x from 2.19 (`7.18.2` on 2.22.1). A copy of the other major, installed or hoisted, breaks every plugin link.
- **Creating a calculated option through Medusa's own `POST /admin/shipping-options` fails.** Medusa 2.17.2 needs `prices: []` even when `price_type` is `calculated`. The plugin's shipping page sends it.
- **Dispatch doesn't create a Medusa fulfilment.** Check that the shipping option's fulfilment set is linked to a stock location, that managed-inventory variants have a level there, and that the order isn't cancelled. The order's Print Trail timeline names the refusal.
- **"Reconnect Print Trail".** Print Trail answered 401: the API token or channel ID is wrong, or the token was revoked. Since Print Trail API 1.2.0 an unknown channel ID gets the same 401 as a bad token. Check `PRINT_TRAIL_CHANNEL_ID`, regenerate the token in the Print Trail app if needed, set `PRINT_TRAIL_API_TOKEN`, restart, and press Test connection. While the 401 lasts, the sweep and reconcile make one check per run instead of a request per order: Print Trail allows 60 failed requests a minute per IP address, then refuses everything from it for the rest of the minute.
- **"The Print Trail channel is inactive".** Print Trail answered 403 `channel-inactive` (API 1.2.0): the channel was set inactive in Print Trail, which refuses every request from it and sends it no webhooks. Orders, cancels and edits wait with that attention, costing no retry attempt. Make the channel active in Print Trail (Settings → Channels) and press Test connection; the waiting work runs on the next sweep (within about 15 minutes). A 401 waits the same way. A 403 saying "This team is inactive" (the team can still read and cancel, not send or confirm) or that the token belongs to the Standard channel (create a dedicated channel and token) shows Print Trail's own words, and is not retried: fix it in Print Trail, then Resend.
- **429 Too Many Requests.** Print Trail limits each token (600 requests a minute) and failed requests per IP address. The plugin waits a short `Retry-After` out, otherwise stops sending until the wait is over and leaves the work to the stored retries and the sweep. Repeated 429s usually mean a wrong token or channel ID on this server or another one behind the same address.
- **"Print Trail reference …" in an error.** Print Trail failed unexpectedly (500). The error keeps Print Trail's `reference`: quote it to Print Trail support. The plugin retries as usual.
- **Webhook registration refused (422).** Print Trail API 1.2.0 accepts only an `https://` URL of at most 200 characters on a public host that resolves, and re-checks it before every delivery (redirects aren't followed). A webhook registered earlier at an `http://` or private address no longer receives anything: put the store behind HTTPS (or an HTTPS tunnel for a local store), set `MEDUSA_BACKEND_URL` and press Test connection.
- **"The order is over Print Trail's limits".** Print Trail API 1.2.0 refuses an order number, `printTrailOrderNumber` or SKU over 255 characters and more than 500 lines, and the Print Trail API takes only whole-number quantities, while Medusa allows a fractional one (a product sold by weight, say). The order isn't sent, and a fractional quantity is never rounded; shorten the value (the `orderNumber` or `payload` hook, or `print_trail_sku`), split the order or correct the quantity with an order edit, then Resend. An order edit that leaves a fractional quantity on a sent order isn't sent to Print Trail either, and the order's timeline says why.

## Removing the plugin

1. Remove the `plugins` entry and the Print Trail provider from the fulfilment providers in `medusa-config.ts`. Keep the manual provider. Delete or replace any shipping options that use `print-trail_print-trail` first.
2. If you don't want the data, drop the plugin's tables: `print_trail_order`, `print_trail_order_event`, `print_trail_state`, `print_trail_variant`, and the order link table (Medusa names it `printtrail_print_trail_order_order_order`; `\dt *print_trail_order*` in psql lists it).
3. Remove the webhook from the channel in the Print Trail app.

Fulfilments, shipments and stock levels the plugin wrote into Medusa stay.

## Licence

The plugin is licensed under the [PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0). The full terms are in `LICENSE`, which ships with the package. In short, you can use it for anything except competing with it:

- Any store can install and run it, commercial stores included, at no charge.
- You can change it and pass on copies, changed or not, so an agency can install it for its clients. Whoever gets a copy from you must also get the licence terms and the `Required Notice:` line in `LICENSE`.
- You can't use it to provide a product that competes with it, such as a Medusa integration for another fulfilment service built from this code.

The noncompete makes it a source-available licence, not an open-source one. This is a summary; the terms in `LICENSE` decide.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
