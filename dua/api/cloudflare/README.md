# DUA NDA backend - Cloudflare free deployment

This folder is the $0/month deployment option for the NDA signer log. It uses a Cloudflare Worker for the API and a Cloudflare D1 database for durable records.

## Required Cloudflare configuration

1. Create a Worker called `dua-nda-api` from this folder.
2. Create a D1 database named `dua-nda-records`.
3. Add the D1 database to the Worker as a binding named `DB`.
4. Add Worker secrets:
   - `ADMIN_PASSWORD`: unique password, at least 16 characters.
   - `SESSION_SECRET`: a different random secret, at least 32 characters.
5. Add the Worker variable `ALLOWED_ORIGINS` with the value `https://mikek.ai`.

The Worker creates its tables automatically after the D1 binding is connected. It provides the same public NDA endpoint and private admin page as the Render implementation:

- `POST /api/nda-acknowledgments`
- `GET /admin`
- `GET /api/admin/acknowledgments.csv`
- `GET /health`

Keep the final Worker URL for the `nda-api-base` meta tag in `../../index.html`.
