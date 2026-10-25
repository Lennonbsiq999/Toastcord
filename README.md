# Toastcord

Toastcord is a Discord-style community chat app with text channels, DMs, voice-channel presence, profile/shop features, and ToastLab productivity tools.

## Current source snapshot

This repository mirrors the source currently deployed at https://toastcord-zmx27r.v2.appdeploy.ai/.

The app currently uses AppDeploy-specific packages (`@appdeploy/client` and `@appdeploy/sdk`) for authentication, APIs, realtime events, storage, and database access. It is **not yet standalone-hostable** from this repository alone. A separate hosting/database migration is required before a GitHub workflow can deploy it independently.

## Current known issue

Production logs show `AppDatabaseGatewayUnavailable` on `/api/messages`, `/api/members`, and `/api/voice/participants`. Do not treat a clean static build or QA snapshot as proof that these live backend routes work; they need runtime verification against a healthy database or a working storage-backed fallback.

## Source layout

- `src/` React frontend
- `backend/` AppDeploy server handlers and realtime subscriptions
- `tests/tests.json` QA test plan

## Local development

The original runtime injects/hosts AppDeploy-specific packages. For an independent local build, first replace those dependencies with a self-hosted API/auth/realtime implementation and configure a persistent database plus TURN credentials for reliable voice/screen sharing.
