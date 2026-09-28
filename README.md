# Payment Reminder – Bulk WhatsApp

Upload an Excel sheet of pending payments, validate and preview it, then send personalised
WhatsApp payment reminders through an approved WhatsApp Business API provider. Every customer
is an independent background job, so **one failure never stops the batch**. Statuses update
live, and every action is audited.

```bash
npm install
ADMIN_PASSWORD='choose-a-password' npm run seed
npm run dev   # http://localhost:3000  (mock provider – nothing is really sent)
npm test
```

Full documentation covers architecture, env vars, provider and webhook setup, API, deployment,
and WhatsApp approval requirements: [docs/BULK_WHATSAPP_REMINDERS.md](docs/BULK_WHATSAPP_REMINDERS.md).
