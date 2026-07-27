# DUA NDA Backend

This service receives and retains proposal acknowledgments, then exposes them only through the password-protected `/admin` page.

## Run locally

1. Create `api/.env` from `.env.example` and replace the placeholder password and session secret.
2. From `api`, run `npm start`.
3. Open `http://localhost:8787/admin` to view the signer log.

The local proposal automatically submits to `http://localhost:8787` when opened from `localhost` or `file://`.

## Deploy

GitHub Pages cannot run this server. Deploy `api/` to a Node host with a persistent disk or volume, set the values in `.env.example` as deployment environment variables, and mount the `api/data` directory persistently. A `Dockerfile` is included for hosts that support Docker deployments.

Set `COOKIE_SECURE=true` behind HTTPS. Set `ALLOWED_ORIGINS` to the exact deployed DUA proposal origins. Then set the `nda-api-base` meta value in `index.html` to the deployed HTTPS API origin, for example `https://nda-api.example.com`.

Never commit `.env` or the data file. Back up `data/nda-acknowledgments.json` regularly. The admin password is the sole credential for the signer log, so use a unique password manager-generated value. The host must provide HTTPS, a persistent disk, and an API origin such as `https://nda-api.yourdomain.com`.

## EmailJS

The server records acknowledgments before any notification work. Once EmailJS service, template, and server-side credential values are available, add the notification call immediately after `addAcknowledgment()` in `server.mjs`. Do not put private EmailJS credentials in `index.html`.
