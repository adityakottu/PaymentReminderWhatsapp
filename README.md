# Payment Reminder – Bulk WhatsApp

Upload an Excel sheet of pending payments, validate and preview it, then send personalised
WhatsApp payment reminders through an approved WhatsApp Business API provider. Every customer
is an independent background job, so **one failure never stops the batch**. Statuses update
live, and every action is audited.

```bash
npm install
ADMIN_PASSWORD='choose-a-password' npm run seed
npm run dev   # http://localhost:3000 – WhatsApp "not connected" until configured
WHATSAPP_PROVIDER=mock npm run dev   # demo/TEST MODE: messages are simulated, nothing is sent
npm test
```

**Connecting real WhatsApp:** set `WHATSAPP_PROVIDER=meta_cloud` and the `WHATSAPP_*` credentials on the
server (see `.env.example`), then open **Settings → WhatsApp Connection** to check the connection and send a
test message. Until then the app shows a banner and does not report anything as sent.

Full documentation covers architecture, env vars, provider and webhook setup, API, deployment,
and WhatsApp approval requirements: [docs/BULK_WHATSAPP_REMINDERS.md](docs/BULK_WHATSAPP_REMINDERS.md).

**iOS and Android apps:** `mobile/` (Capacitor). See [docs/MOBILE_APPS.md](docs/MOBILE_APPS.md).
