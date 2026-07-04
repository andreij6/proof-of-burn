---
type: idea
title: "Lottery FCM reminder — \"draws in 1 hour\" push"
tags: [ideas, lottery-fcm-reminder]
timestamp: 2026-06-20T04:38:29-04:00
---

# Lottery FCM reminder — "draws in 1 hour" push

Scope an idea (NOT built): push a Firebase Cloud Messaging notification to opted-in
users **1 hour before** each lossless-lottery drawing. The app already ships a
Firebase web app (`src/frontend/src/firebase.ts` — analytics only) and Firebase v12
is a dependency, so the client SDK is one import away. What's missing is the messaging
wiring, an opt-in toggle, a Principal→device token registry, and — the load-bearing
piece — an **off-chain scheduler** that actually fires the push.

## The one-line summary

> Users opt in on the Lottery page → the frontend registers a Firebase Messaging
> service worker, gets an FCM token, and writes it to the canister against their
> Principal. A small off-chain Cloud Run job polls `get_lottery_info().next_draw_at`
> and, at `next_draw_at − 1h`, sends each registered device an FCM push. The canister
> never sends a push itself — FCM v1 needs an OAuth2 access token minted from a
> service-account JWT (RS256), which an IC canister cannot sign (it can sign with
> threshold ECDSA/BLS, not arbitrary RSA). That single constraint decides the
> architecture: **push sender must be off-chain.**

## Files

- `01-overview.md` — what / why / architecture / options considered / the decisive constraint
- `02-impl.md` — backend (token registry + opt-in) + frontend (SW + toggle) + off-chain scheduler
- `03-risks-gates.md` — risks, build gates, open questions

## Status / recommendation

Additive, low-risk, sized **medium** (the off-chain scheduler + token-on-chain privacy
decision are the only non-trivial parts). Reuses the existing Firebase project + the
Cloud Run deployment pattern already established for the X-Farm proxy. Rides the
`lossless_lottery` flag. Recommend building — but resolve **Q1** (token storage
on-chain vs off-chain) and **Q2** (notification content + personalization depth)
first; both change the scope.