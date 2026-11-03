# Privacy Policy — D&D Dungeon Master for Anna

Effective date: 2026-11-03

D&D Dungeon Master is an app that runs inside Anna. This policy explains what it does with your data. The short version: the app has no server of its own, collects no analytics, and does not sell or share your data.

## What the app stores

- **Campaigns.** Your campaign names, premises, parties, story events, saved turns and progress are stored in your own Anna user storage, under your Anna account. The developer cannot read them. You can delete a campaign from the app at any time, which removes it from your Anna storage.
- **Nothing else.** The app does not create accounts, set tracking cookies, or keep a separate database.

## What is sent to AI models

- **Gameplay text.** When you create a campaign or play a turn, your premise, party details, actions and saved campaign state are sent to Anna's language model through Anna's sampling feature to generate the story. This is processed by Anna under Anna's own terms and privacy policy, and it counts against your Anna usage quota. The developer does not receive these requests or responses.
- **Reference data.** The adventure text, character classes and rules lookups are bundled inside the app. Looking them up does not send your data anywhere.

## Optional voice feature

Voice input is off unless you turn it on and an Anna credential for Google Gemini is configured.

- When used, the app asks Google's Gemini service for a short-lived token, and your browser then streams your microphone audio to Google's Gemini Live service (`generativelanguage.googleapis.com`) to transcribe your speech and speak replies.
- That audio and text are handled by Google under Google's terms and privacy policy.
- If you do not use voice, no audio is captured or sent.

## What the developer collects

Nothing. The developer receives no analytics, logs, campaign content, audio or personal information from the app.

## Third parties

The only third parties involved are the services above: Anna (hosting, storage and the language model) and, only if you use voice, Google Gemini. Please review their policies for how they handle data.

## Children

The app is a general-audience game and is not directed at children under 13. It does not knowingly collect personal information from anyone.

## Changes

If this policy changes, the updated version will be posted at this location with a new effective date.

## Contact

Questions or requests about this policy: open an issue at https://github.com/ykamoji/dnd-dungeon-master-anna/issues.
