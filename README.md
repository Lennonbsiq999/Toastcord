# Toastcord

Toastcord is a Discord-style community chat app with text channels, DMs, voice-channel presence, profile/shop features and ToastLab productivity tools.

## Source and deployment status

This repository mirrors the source from the currently deployed AppDeploy app: https://toastcord-zmx27r.v2.appdeploy.ai/.

The backend now includes a storage-backed degraded path for the default Toast Zone, text-message history, member presence and voice-session presence. These fixes are committed here, but they are **not live** until built and deployed. The AppDeploy usage limit previously blocked deployment, so real runtime verification is still outstanding.

The code currently uses AppDeploy-specific packages (@appdeploy/client and @appdeploy/sdk) for authentication, API routing, realtime, storage and database access. It is **not independently hostable from GitHub alone**. Running it elsewhere requires replacing those platform-specific dependencies and configuring a persistent database. A clean source upload is not the same as a working deployment, a fact worth remembering before declaring victory.

## Security

The hardcoded admin unlock code was removed from this public source. Configure the AppDeploy secret named ADMIN_CODE before using admin unlock. Never commit secret values.

Reliable audio and screen sharing may require TURN credentials configured as AppDeploy secrets TURN_URLS, TURN_USERNAME and TURN_CREDENTIAL. STUN alone does not guarantee that every pair of networks can connect. A GitHub push by itself does not deploy the app.

## Layout

- src/: React frontend, ToastLab and Rewards panel
- backend/: server routes and realtime helpers
- tests/tests.json: QA test scenarios
