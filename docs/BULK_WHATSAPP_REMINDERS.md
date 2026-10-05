# Bulk WhatsApp Payment Reminders

Excel upload → validation preview → review → confirmed send → live dashboard,
built as an asynchronous, database-backed job system where **one customer = one
independent message job**. A failure on any recipient is recorded on that
recipient only; the worker always continues with the rest.

```
Excel upload ─► validation (bulk_upload_rows) ─► import (bulk_reminder_records, PENDING)
   ─► review / template / preview ─► confirm send (records → QUEUED, batch PROCESSING)
   ─► worker claims jobs individually (lease + lock token) ─► rate limiter ─► WhatsAppProvider
   ─► SENT / RETRY_SCHEDULED / INVALID_NUMBER / NOT_ON_WHATSAPP / PROVIDER_ERROR / FAILED …
   ─► provider webhooks (signed) ─► DELIVERED / READ / async failures ─► SSE dashboard
```

> The repository had no existing application, so authentication, roles,
> permissions and the audit log were created here as small, self-contained
> modules (`src/auth`, `src/audit`). If this is merged into a larger app, replace
> `authenticate` / `requirePermission` in `src/auth/auth.js` with the host app's
> equivalents; the rest of the feature only depends on `req.user.permissions`.

### Message languages (English / Telugu)

Each batch has a **message language**: *English*, *Telugu (తెలుగు)* or *English + Telugu*. The last one sends one
message with the English text first and the Telugu text below it. Pick the language on the **Review** step,
where both templates can be edited and previewed. An optional **Language** column in the Excel (`English`,
`Telugu` or `Both`) overrides the batch language for individual customers. Default templates for both
languages are managed under **Settings → Message Template**. Each record stores the language it was sent in,
and the Excel export includes it. The built-in Telugu text should be reviewed by a native speaker before
production use.

---

## 1. Files

| Path | Purpose |
| --- | --- |
| `src/config.js` | All configuration (env vars, defaults, production checks) |
| `src/db.js` | Knex setup (SQLite for single server, PostgreSQL for scale) |
| `migrations/20260928000001_bulk_whatsapp_reminders.js` | Schema |
| `migrations/20260929000001_message_languages.js` | Message language (English / Telugu / both) columns |
| `src/auth/auth.js`, `src/auth/permissions.js` | Sign-in (HttpOnly JWT cookie), roles, permissions, user admin API |
| `src/audit/audit.js` | Append-only audit log |
| `src/bulk/excel.js` | Excel parsing (header detection, aliases) + template workbook |
| `src/bulk/validation.js` | Row validation, duplicate detection |
| `src/bulk/phone.js` | Indian phone normalisation (`9876543210` → `919876543210`) |
| `src/bulk/template.js` | Safe `{{var}}` / `{{#if}}` message renderer, default template |
| `src/bulk/service.js` | Batches, import, send, pause/resume/cancel, retry, counters, webhook status application |
| `src/bulk/statuses.js` | Batch / record statuses and filters |
| `src/bulk/routes.js` | REST API + SSE stream + exports |
| `src/bulk/webhookRoutes.js` | Provider webhook endpoints |
| `src/bulk/export.js` | Excel (formula-injection safe) and PDF reports |
| `src/whatsapp/provider.js` | Provider contract + error categories |
| `src/whatsapp/metaCloudProvider.js` | Meta WhatsApp Cloud API adapter (send, error mapping, signature, webhook parsing) |
| `src/whatsapp/mockProvider.js` | Deterministic mock for dev/tests (refused in production) |
| `src/whatsapp/index.js` | Provider factory — add new providers here |
| `src/queue/worker.js` | Durable worker: claiming, isolation, retries, crash recovery, reconciliation |
| `src/queue/rateLimiter.js` | Token bucket + global back-off |
| `src/app.js`, `src/server.js`, `src/worker.js` | App wiring, web process, standalone worker process |
| `public/` | UI (no build step): upload, validation, review, send, live dashboard, history, template, audit |
| `scripts/` | migrate, seed, create-user, generate-template |
| `macros/BulkReminderPrep.bas` | Optional Excel prep macro (never sends) |
| `test/` | Unit, API, worker, webhook, acceptance and load tests |
| `Dockerfile`, `.github/workflows/` | Container image, CI and GHCR publishing |

## 2. Database migrations

`migrations/20260928000001_bulk_whatsapp_reminders.js` (applied automatically at
start-up, or with `npm run migrate`) creates:

- `bulk_upload_batches` – batch number `BULK-YYYYMMDD-NNN`, file name + SHA-256, uploader, timestamps, status, counters (total/valid/invalid/duplicate/processed/successful/failed/pending/cancelled), message template snapshot, duplicate override flag.
- `bulk_upload_rows` – every parsed row with its validation status (VALID/INVALID/DUPLICATE), reasons and warnings.
- `bulk_reminder_records` – **one row per message job**: customer data, rendered message, status, failure reason, provider error code, provider message id, attempts, retry eligibility, `dedupe_key`, unique `idempotency_key`, lease columns (`locked_by`, `lock_token`, `locked_until`, `reconcile_until`) and all lifecycle timestamps.
- `whatsapp_message_logs` – one row per provider request (IN_FLIGHT → ACCEPTED/FAILED/UNKNOWN) plus delivery status.
- `webhook_events` – de-duplicates redelivered webhooks; keeps early/unmatched events for replay.
- `whatsapp_opt_outs` – consent (STOP replies, provider opt-out errors, manual entries).
- `audit_logs` – user id, username, role, action, description, JSON details, batch id, record id, IP, user agent, timestamp.
- `users`, `user_permissions`, `message_templates`.

## 3. Environment variables

See `.env.example` for the complete list with comments. Key ones:

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | – | **Required in production**, ≥ 32 random chars |
| `DATABASE_CLIENT` / `SQLITE_FILENAME` / `DATABASE_URL` | `better-sqlite3` | Use `pg` for multiple instances/workers |
| `WHATSAPP_PROVIDER` | `mock` | `meta_cloud` in production (mock is refused) |
| `WHATSAPP_API_TOKEN` | – | Secret – server-side only |
| `WHATSAPP_PHONE_NUMBER_ID` | – | |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | – | |
| `WHATSAPP_WEBHOOK_SECRET` | – | Meta **App Secret**, verifies `X-Hub-Signature-256` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | – | Random string entered in Meta's webhook config |
| `WHATSAPP_SEND_MODE` | `template` | `text` only valid inside a 24h service window |
| `WHATSAPP_TEMPLATE_NAME` / `_LANGUAGE` / `_PARAMS` | `payment_reminder` / `en` / `customer_name,amount_due,due_date,account_id` | Must match the approved template |
| `WHATSAPP_TEMPLATE_NAME_TE` / `_LANGUAGE_TE` | `payment_reminder` / `te` | Approved Telugu translation |
| `WHATSAPP_TEMPLATE_NAME_BOTH` / `_LANGUAGE_BOTH` / `_PARAMS_BOTH` | `payment_reminder_bilingual` / `en` / same as `_PARAMS` | Approved bilingual (English + Telugu) template |
| `MAX_RETRIES` | `3` | Total attempts for temporary failures |
| `RETRY_BASE_DELAY_MS` / `RETRY_MAX_DELAY_MS` | 30 s / 15 min | Exponential back-off with jitter |
| `WORKER_CONCURRENCY` | `5` | Parallel jobs per worker process |
| `SEND_RATE_PER_SECOND` | `10` | Per worker process — set from your provider's *current* limits |
| `WORKER_LEASE_MS` | 2 min | Crash detection |
| `RECONCILE_WINDOW_MS` | 15 min | Wait for webhook after a mid-send crash |
| `DUPLICATE_WINDOW_HOURS` | `24` | Duplicate-send protection window |
| `MAX_UPLOAD_MB` / `MAX_ROWS` | 5 / 10000 | |
| `INTERNATIONAL_NUMBERS_ENABLED` | `false` | Non-Indian numbers kept as-is only when enabled |
| `RUN_WORKER_IN_PROCESS` | `true` | Set `false` on web nodes when running `npm run worker` |

## 4. WhatsApp provider configuration (Meta WhatsApp Cloud API)

**Connection modes.** `WHATSAPP_PROVIDER` decides whether messages really go out:

| Value | Mode | What happens |
| --- | --- | --- |
| `meta_cloud` (with credentials) | **Live** | Messages are sent through the WhatsApp Cloud API |
| `mock` | **Test mode** | Nothing is sent. Results are simulated and labelled "(simulated)" on screen, in history and in exports. Refused in production |
| not set / credentials missing | **Not connected** | The app works, but sending is blocked with a clear message |

A red/orange banner is shown on every page unless the connection is live. A batch remembers the mode it was
sent in, so a test-mode batch can never be resumed or retried as real messages (and vice versa).
**Settings → WhatsApp Connection** (admins) shows what is configured (never the secrets), checks the access
token, sender number and template approval with Meta, shows the webhook URL and last update received, and can
send one real test message.

1. Create a Meta Business account and a **WhatsApp Business Account (WABA)** in Meta Business Manager; complete **business verification**.
2. Create a Meta App (type *Business*), add the **WhatsApp** product, register and verify your sending phone number, and set its **display name** (requires approval).
3. Create a **System User** with a **permanent access token** having `whatsapp_business_messaging` and `whatsapp_business_management` → `WHATSAPP_API_TOKEN`.
4. Copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`, and the **WABA ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`.
5. App → Settings → Basic → **App Secret** → `WHATSAPP_WEBHOOK_SECRET`.
6. Create and submit a **message template** (category *Utility*), e.g. name `payment_reminder`, language `en`, body:
   ```
   Hello {{1}}, this is a reminder regarding your pending payment of ₹{{2}}. Due date: {{3}}. Loan/Account ID: {{4}}. Please make the payment at your earliest convenience. Thank you.
   ```
   Keep `WHATSAPP_TEMPLATE_PARAMS` in the same order as `{{1}}..{{n}}`. Empty values are sent as `-` (Meta rejects empty parameters).
   **Telugu:** add a Telugu (`te`) translation to the same template in WhatsApp Manager, e.g.
   ```
   నమస్కారం {{1}} గారు, మీరు చెల్లించవలసిన ₹{{2}} బకాయి గురించి ఇది ఒక రిమైండర్. చెల్లింపు గడువు తేదీ: {{3}}. లోన్/ఖాతా నంబర్: {{4}}. దయచేసి వీలైనంత త్వరగా చెల్లింపు చేయండి. ధన్యవాదాలు.
   ```
   **English + Telugu:** create a separate template (default name `payment_reminder_bilingual`) whose body has
   the English text followed by the Telugu text. List its parameters in `WHATSAPP_TEMPLATE_PARAMS_BOTH`
   (e.g. the four variables twice if each language uses its own `{{n}}`).
7. Set `WHATSAPP_PROVIDER=meta_cloud` and `WHATSAPP_SEND_MODE=template`.

**Switching providers.** Implement the contract in `src/whatsapp/provider.js`
(`sendMessage`, `verifyWebhookSignature`, `handleVerificationChallenge`,
`parseWebhook`), map the provider's error codes to the error kinds, and register
it in `src/whatsapp/index.js`. Nothing else changes.

**Error mapping** (`META_ERROR_MAP` in `metaCloudProvider.js`): 131026 → `NOT_ON_WHATSAPP`;
100/131009 mentioning the recipient number → `INVALID_NUMBER`; 131050 → opted out;
130429/131056/80007/4/HTTP 429 → rate limited (retry); 131000/131016/HTTP 5xx/network/timeout
→ temporary (retry); template/auth/policy errors → permanent provider error (no automatic
retry). A generic failed request is **never** assumed to mean "not on WhatsApp". Review
this table against Meta's current error-code documentation before go-live.

## 5. API endpoints

All under `/api`, cookie-authenticated; state-changing requests need the header `X-Requested-With: fetch`.

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/auth/login`, `/auth/logout`; GET `/auth/me` | – |
| GET/POST | `/users`, PUT `/users/:id/permissions` | `users.manage` |
| GET | `/bulk-reminders/template.xlsx` | `bulk_whatsapp_reminders` |
| GET | `/bulk-reminders/config` | `bulk_whatsapp_reminders` |
| POST | `/bulk-reminders/uploads` (multipart `file`) | `…upload` |
| GET | `/bulk-reminders/batches` (history), `/batches/:id`, `/batches/:id/issues` | `bulk_whatsapp_reminders` (scoped) |
| POST | `/batches/:id/import`, `/batches/:id/cancel-upload` | `…upload` |
| POST | `/batches/:id/preview` ; PUT `/batches/:id/template` | view ; `…edit_batch_template` |
| GET | `/batches/:id/send-readiness` | view |
| POST | `/batches/:id/send` `{confirm:true, overrideDuplicates?, expectedRecipients?}` | `…send` (+ `…override_duplicates`) |
| POST | `/batches/:id/pause`, `/resume`, `/cancel` | `…control` |
| POST | `/batches/:id/retry-failed` `{recordIds?}` | `…retry` |
| GET | `/batches/:id/records?filter=&q=&page=` , `/records/:rid/attempts` | view (scoped) |
| GET | `/batches/:id/stream` (Server-Sent Events) | view |
| GET | `/batches/:id/export.xlsx`, `/export.pdf` | `…export` |
| GET/PUT | `/bulk-reminders/message-template` | view / `whatsapp_settings.manage` |
| GET/POST/DELETE | `/bulk-reminders/opt-outs` | `whatsapp_settings.manage` |
| GET | `/audit-logs?batchId=&action=` | `audit_logs.view` |
| GET/POST | `/webhooks/whatsapp` | provider signature |
| GET | `/healthz` | – |

## 6. Queue / worker configuration

- The queue **is** the `bulk_reminder_records` table (durable; survives restarts; no Redis needed).
- Claiming: a transaction selects due jobs from `PROCESSING` batches (`FOR UPDATE SKIP LOCKED` on PostgreSQL) and stamps them with a unique lock token and lease.
- Each job runs in its own `try/catch`; outcomes are written only to that job. Unexpected exceptions become temporary failures of that job.
- Before each provider call an `IN_FLIGHT` log row is committed. After a crash:
  - no in-flight log → provider never called → job re-queued;
  - in-flight log → **not resent**; held for `RECONCILE_WINDOW_MS` waiting for a webhook matched by the idempotency key (`biz_opaque_callback_data`), then marked FAILED "outcome unknown" for a human to decide.
- Rate limiting: token bucket (`SEND_RATE_PER_SECOND`) + global pause on provider rate-limit responses (honours `Retry-After`).
- Pause stops new claims; in-flight jobs finish. Cancel marks pending/queued/retrying jobs `CANCELLED`; sent messages and history are kept.
- Scaling: run `npm run worker` processes (with `RUN_WORKER_IN_PROCESS=false` on web nodes) against PostgreSQL. Effective rate = processes × `SEND_RATE_PER_SECOND`.

## 7. Webhook configuration

- Callback URL: `https://<your-domain>/webhooks/whatsapp`
- Verify token: the value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Subscribe the WABA to the **`messages`** field (carries status updates and inbound replies).
- Every POST is verified with HMAC-SHA256 of the raw body using the App Secret; invalid signatures get `401` and are audited.
- Duplicate deliveries are ignored (`webhook_events.event_key`), statuses only move forward (never READ → DELIVERED), events arriving before the send result are replayed, and processing errors return `500` so Meta redelivers.
- Inbound `STOP` / `UNSUBSCRIBE` replies add the number to `whatsapp_opt_outs`; opted-out numbers are never messaged.

## 8. Excel template

Download from the UI (**Download Excel Template**) or `GET /api/bulk-reminders/template.xlsx`
(a copy is in `templates/bulk-whatsapp-reminder-template.xlsx`). Columns: Customer Name*,
Phone Number*, Amount Due*, Due Date (DD-MM-YYYY), Loan/Account ID, Installment Number,
Employee/Collector, Custom Message, Language (English / Telugu / Both). The single sample row is marked `SAMPLE` and is ignored on
import. Only `.xlsx` is accepted (legacy `.xls` gets a "Save As .xlsx" message).

Optional: `macros/BulkReminderPrep.bas` normalises phones, highlights invalid/duplicate rows and
totals amounts. It never sends messages.

## 9. Testing

```bash
npm ci
npm test            # unit, API, RBAC, worker resilience, webhooks, acceptance (10 customers), 1,000-record volume
npm run test:load   # 1,000 and 5,000 records
```

Covered: the §30 acceptance scenario (customers 3 and 7 fail permanently, 5 temporarily; batch
completes), 1,000/5,000 records, duplicates within file and across uploads, worker crash before
and after the provider call, browser closed / user logged out, API timeout, rate limiting,
retry + Retry Failed eligibility, webhook signature/duplicates/out-of-order/early arrival,
opt-out, cancellation, pause/resume, formula injection, role-based access and CSRF.

Mock provider phone suffixes for manual demos: `…000` not on WhatsApp, `…111` invalid number,
`…222` temporary failure once, `…333` always temporary, `…444` rate limited once, `…555` timeout once,
`…666` template error.

## 10. Local development

```bash
cp .env.example .env               # set JWT_SECRET and ADMIN_PASSWORD
npm install
ADMIN_PASSWORD='choose-a-password' npm run seed   # admin + demo users (mainhead, suresh, ramesh)
npm run dev                         # http://localhost:3000
```

Sign in as `admin`, open **Payments → Bulk WhatsApp Reminders**, download the template, upload.
With `WHATSAPP_PROVIDER=mock` nothing leaves your machine, and delivered/read callbacks are simulated.

## 11. Production deployment

1. **CI/CD on GitHub:** `.github/workflows/ci.yml` runs all tests on every push/PR.
   `.github/workflows/deploy.yml` runs the tests and publishes a container image to
   `ghcr.io/<owner>/<repo>` (tags: branch, sha, `latest` on the default branch). Set a repository
   secret `DEPLOY_HOOK_URL` to automatically trigger your host's deploy hook after publishing.
2. **Run the image** on any container host (VM with Docker, Render, Railway, Fly.io, ECS, Kubernetes).
   GitHub Pages cannot host this app — it needs a server, a database and a public HTTPS URL for webhooks.
   ```bash
   docker run -d -p 3000:3000 -v prw-data:/data --env-file production.env ghcr.io/<owner>/<repo>:latest
   docker exec -e ADMIN_PASSWORD='…' <container> node scripts/seed.js
   ```
3. Provide secrets via the host's secret manager (never in the image or frontend): `JWT_SECRET`,
   `WHATSAPP_*`. Set `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true` behind a proxy.
4. Terminate TLS in front of the app; expose `/webhooks/whatsapp` publicly over HTTPS.
5. Single instance: SQLite on a persistent volume (`/data`) is fine. More than one instance or
   dedicated workers: `DATABASE_CLIENT=pg` + `DATABASE_URL`, web nodes with `RUN_WORKER_IN_PROCESS=false`,
   and N × `npm run worker`.
6. `SIGTERM` lets in-flight jobs finish; unstarted jobs remain queued and resume on the next start.
7. Health check: `GET /healthz`. Back up the database (it is the audit record).

## 12. WhatsApp Business / policy requirements before production

- Verified Meta Business account, WABA, registered sender number with approved display name.
- **Approved message template** (Utility category) for payment reminders. Business-initiated messages
  outside the 24-hour customer-service window must use an approved template; free text is rejected (error 131047).
- **Customer opt-in**: you must have the customer's consent to receive WhatsApp messages from you, and honour
  opt-outs (STOP handling and `whatsapp_opt_outs` are built in).
- Messaging limits / quality rating: new numbers start with a limited number of business-initiated
  conversations per 24h, increasing with quality and volume. Size batches and `SEND_RATE_PER_SECOND`
  to your current tier. Check Meta's current limits instead of relying on fixed numbers.
- Pricing: template conversations are billed per Meta's current pricing; add a payment method on the WABA.
- Content: follow the WhatsApp Business and Commerce policies; avoid threatening or harassing collection
  language; comply with applicable Indian regulations (e.g. RBI fair-practices guidance for recovery
  communication, DPDP Act for personal data).
- Test with Meta's test number first (recipients must be on its allowed list — error 131030 otherwise).
