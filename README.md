# Print Trail for Medusa

`medusa-plugin-print-trail` is a Medusa v2 plugin that connects a Medusa store to the [Print Trail API](https://docs.printtrail.com/developers/api-documentation/) for automated order fulfilment of books and printed products.

- Orders containing Print Trail products are sent to Print Trail and confirmed automatically.
- Each Print Trail parcel comes back as a Medusa fulfilment and shipment, with its tracking number and its own shipment email.
- Stock levels, pre-orders included, are synced from Print Trail into Medusa inventory.
- Cancels, order edits, claims and exchanges made in Medusa are carried to Print Trail.

Website: [printtrail.com](https://printtrail.com/). Guide: [docs.printtrail.com/channels/medusa](https://docs.printtrail.com/channels/medusa/).

## Screenshots

![The Print Trail fulfilments and timeline widget on a Medusa order: one fulfilment dispatched by tracked shipping with its Royal Mail tracking number, and a timeline from sent and confirmed to completed](media/order-widget.png)

The order page: each Print Trail fulfilment with its tracking, and the order's Print Trail timeline.

![The Print Trail settings page: the connection shows Connected with the channel, team and Print Trail API version, and the webhook is registered with its secret from Print Trail](media/settings.png)

Settings → Print Trail: the connection and the webhook.

![The Print Trail shipping page: three rate-card shipping options with their Print Trail methods and weight bands, the Europe option with its own bands for Ireland](media/shipping-rate-cards.png)

Print Trail shipping: options priced by weight band, here with Ireland's own bands.

## Requirements

- Medusa `^2.17.2`, tested on 2.17.2 and 2.22.1.
- Node 22.
- A Print Trail account with a channel for the store, and the channel's API token.
- Redis locking (Medusa's Locking Module with its Redis provider) when the store runs more than one process (a server and a worker count as two). Without a shared lock, two processes can send the same order twice.

## Setup

### 1. Install

In the store:

```bash
npm install medusa-plugin-print-trail
```

### 2. Configure `medusa-config.ts`

```ts
import { printTrailOptionsFromEnv } from "medusa-plugin-print-trail/config"

const printTrail = printTrailOptionsFromEnv()

module.exports = defineConfig({
  // …
  plugins: [{
    resolve: "medusa-plugin-print-trail",
    options: {
      ...printTrail,
      backendUrl: process.env.MEDUSA_BACKEND_URL,
      adminUrl: process.env.MEDUSA_ADMIN_URL,
      notifications: { adminEmail: process.env.PRINT_TRAIL_ADMIN_EMAIL },
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

There are two blocks because Medusa passes a plugin's options only to the modules inside it, and a fulfilment provider is registered under the Fulfillment Module instead. `printTrailOptionsFromEnv()` reads the credentials once, so both blocks get the same values.

Setting `providers` replaces Medusa's default list, so keep the manual provider listed or the store's manual shipping options stop working. If the store already has an `@medusajs/medusa/fulfillment` entry, add the Print Trail provider to it.

### 3. Run the migrations

```bash
npx medusa db:migrate
```

They create the plugin's tables and its link to orders.

### 4. Set the environment variables

- `PRINT_TRAIL_BASE_URL`: the Print Trail API host shown in the Print Trail app. It has no default, so set it with the other two: a channel ID or token without it stops the plugin's module loading.
- `PRINT_TRAIL_CHANNEL_ID`: the store's Print Trail channel.
- `PRINT_TRAIL_API_TOKEN`: the channel's API token.
- `MEDUSA_BACKEND_URL`: this backend's public `https://` URL. Print Trail sends its webhooks to `{MEDUSA_BACKEND_URL}/hooks/print-trail`.
- `MEDUSA_ADMIN_URL`: the Medusa admin URL, for links from Print Trail back to the order.
- `PRINT_TRAIL_ADMIN_EMAIL`: who is emailed when a Medusa cancel comes too late for Print Trail. A comma-separated list is accepted.

The plugin reads the three `PRINT_TRAIL_` credentials itself; the other three are the names the config above passes through. Changing any of them needs a restart.

### 5. Connect in the admin

1. Go to Settings → Print Trail and press **Test connection**. It checks the token and channel, registers the store's webhook with Print Trail and fetches the webhook secret.
2. Put the products Print Trail fulfils in a shipping profile of their own.
3. On Settings → Print Trail → Shipping, create a Print Trail shipping option for that profile, with a Print Trail method and weight bands. Its fulfilment set must be linked to a stock location.

Variants are matched to Print Trail by SKU. Where Print Trail's SKU differs, set it in the Print Trail panel on the variant page.

## Documentation

The full guide is at **[docs.printtrail.com/channels/medusa](https://docs.printtrail.com/channels/medusa/)**: setup, rate cards, pre-orders, notifications, the developer reference (options, workflows, hooks, events, jobs and API routes) and troubleshooting.

- [Changelog](https://github.com/consilience/medusa-plugin-print-trail/blob/main/CHANGELOG.md), with each release's upgrade notes.
- [Contributing](https://github.com/consilience/medusa-plugin-print-trail/blob/main/CONTRIBUTING.md): developing and testing the plugin.
- Problems and requests: [GitHub issues](https://github.com/consilience/medusa-plugin-print-trail/issues).

## Licence

The plugin is licensed under the [PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0). The full terms are in `LICENSE`, which ships with the package. In short, you can use it for anything except competing with it:

- Any store can install and run it, commercial stores included, at no charge.
- You can change it and pass on copies, changed or not, so an agency can install it for its clients. Whoever gets a copy from you must also get the licence terms and the `Required Notice:` line in `LICENSE`.
- You can't use it to provide a product that competes with it, such as a Medusa integration for another fulfilment service built from this code.

The noncompete makes it a source-available licence, not an open-source one. This is a summary; the terms in `LICENSE` decide.
