# D&D Dungeon Master for Anna

An Anna-native edition of the D&D Dungeon Master app. This repository contains the Anna static single-page application, its bundled Executa, and Linux x86_64 plus macOS and Windows packaging workflows. The existing web app lives in the separate `dnd-dungeon-master-assistant` repository.

## App behavior

The Anna SPA keeps the existing D&D client’s dark, cinematic interface: the landing poster and “How to Play” section, guided adventure and party setup, resume cards, corner step navigation, and the three-pane game console with layout switching, journey rail, scene/event reader, dice tray, voice control, and approval bar.

- Build a campaign from a player-authored premise and a party of up to six adventurers.
- Run the original backend stages through Anna sampling: input guardrail, intent classifier, story librarian, ACTION/NPC_DIALOGUE/CAMPAIGN specialists, schema/semantic evaluation with retries, and a player approval gate.
- Ground setup and turns in the bundled Tomb of Annihilation file corpus, Open5e character/rules lookups, scene art index, and persistent party/campaign state.
- Let the player approve a draft to commit its action, narration, checks, and story changes, or reject it without applying the proposed state changes.
- Save campaigns in Anna user-scoped storage and resume them after reconnecting.
- Offer optional Gemini Live microphone input and spoken acknowledgements. This feature requires an Executa `GEMINI_API_KEY` credential and Anna approval of the external API integration.

The React screens, styling, artwork, and class portraits are copied from the existing client; the MIT project license is included here. Local fonts carry their SIL Open Font License notices under `ui/public/fonts/`.

The campaign selector preserves the source client’s three entries: Princes of the Apocalypse, Tomb of Annihilation, and Hoard of the Dragon Queen. Tomb of Annihilation is playable; the other two remain marked Coming Soon, matching the existing app. The Anna Executa bundles the original Tomb of Annihilation knowledge index, chapter files, NPC appendix, asset index, and Open5e reference datasets so its librarian and rules tools can retrieve source material offline. Adventure text and third-party dataset terms still need to be confirmed for Marketplace distribution.

## Layout

- `app.json`, `manifest.json`: Marketplace metadata and static SPA runtime declarations.
- `ui/`: the copied Next.js 16 and React client, adapted to Anna storage and the bundled Executa.
- `bundle/`: the static export generated from `ui/`; Anna loads its `index.html` and bundled assets here.
- `executas/dnd-game-master/`: JSON-RPC Executa source, manifest, and local/binary distribution profiles.
- `scripts/`: cross-platform one-file binary build and archive helpers.
- `.github/workflows/build-executa.yml`: builds and checks artifacts for Linux x86_64, macOS Intel/Apple Silicon, and Windows x86_64.

## Requirements

- Node.js and npm for the React UI; Python 3.11 or newer and `uv` for local Executa development.
- Anna’s `@anna-ai/cli` package for validation, host preview, and Marketplace submission (install with `npm install -g @anna-ai/cli`).
- PyInstaller for binary packaging (`python -m pip install -r requirements-build.txt`).
- A Gemini API key stored as the Executa's sensitive `GEMINI_API_KEY` credential to enable optional voice. Do not place credentials in this repository, source files, build logs, or client-side storage.

## Local development

From the repository root, run the React UI with local preview storage, or export the production SPA into `bundle/`:

```sh
npm install --prefix ui
npm run dev --prefix ui
# Open http://localhost:3000/?preview=1 for the deterministic UI preview
# Production export: npm run build --prefix ui
```

Then validate and preview the actual host bundle. To exercise real Anna model sampling and APS storage, authenticate once and use the APS-backed mode:

```sh
anna-app login --host https://anna.partners
anna-app validate --strict
anna-app dev --storage aps
```

For an offline UI/bridge smoke check without an Anna login, use `anna-app dev --no-llm`; it uses the legacy in-memory storage backend and cannot verify model sampling or APS persistence.

The `?preview=1` mode uses localStorage and a deterministic preview narrative for UI work. The Anna SDK connection is required when the preview flag is absent. The build generates exact SHA-256 CSP hashes for Next hydration scripts; it does not enable `unsafe-inline`. The deterministic preview does not exercise Anna model sampling, APS storage, or the hosted Executa runtime. For local Executa tests:

```sh
python -m unittest discover -s tests -v
```

The Executa protocol supports Anna v2 reverse `sampling/createMessage` calls and returns its tool manifest from `describe`. The source mode can be selected through the Executa profile when using `anna-app dev`; the binary artifacts are packaged by CI from the same source.

## Environment variables and API keys

Anna does not automatically load the original backend's `.env` or Cloud Run env file. For hosted Executas, declared values are supplied in `params.context.credentials`. The manifest declares every variable from `dnd-game-master-agent/cloudrun.env.example.yaml`, plus the Anna-specific `GEMINI_API_KEY` voice option. Every entry is optional so the original backend settings do not block installation.

Only `GEMINI_API_KEY` and `GOOGLE_API_KEY` are read by the Anna Executa, and only by `voice_token`. `GEMINI_API_KEY` takes precedence; `GOOGLE_API_KEY` is retained as the original Cloud Run key name and a voice fallback. Neither key is used for text generation: the Anna runtime uses `llm.sample`. Store these keys only as sensitive Anna credentials, never in the repository, UI bundle, or binary.

The other Cloud Run variables are declared to make the source configuration explicit, but are migration references and do not configure the Anna runtime:

| Variable(s) | Original purpose | Anna behavior |
| --- | --- | --- |
| `GOOGLE_MODEL`, `SMART_MODEL`, `USE_LOCAL_LLM` | ADK text model selection | Replaced by Anna `llm.sample`; unused by the Anna Executa. |
| `SESSION_DB_LOCAL` | ADK session persistence mode | Unused; campaigns use Anna user-scoped storage. |
| `MONGO_URI`, `DB_NAME`, `CAMPAIGN_COLLECTION`, `SESSION_COLLECTION`, `EVENT_COLLECTION` | MongoDB campaign/session/event storage | Unused; campaign state uses Anna user-scoped storage. `MONGO_URI` is marked sensitive because it can contain credentials. |
| `LOG_LEVEL` | Cloud Run backend logging | Unused by the Anna Executa. |
| `ALLOW_ORIGINS` | FastAPI CORS configuration | Unused by the static Anna app and bundled Executa. |

`SESSION_SERVICE_URI` is intentionally not declared: the source Cloud Run example says to leave it unset so the original backend uses its local SQLite session store. For local voice development, the ignored `.env` or shell can provide either key; the committed `.env.example` contains only placeholders. The packaged Executa does not include `.env` files.

## Pre-submission checklist

1. Run `npm run build --prefix ui`, then `anna-app validate --strict`; fix all manifest, CSP, host API, and bundled Executa errors before `anna-app dev`.
2. In Anna, create a campaign, play a turn, approve it, play another turn and reject it, reload, and resume the saved campaign. Check storage errors and malformed model responses.
3. Build and register the Linux x86_64 binary, then run the bundled Executa with an Anna Cloud Agent. Confirm sampling negotiation, tool invocation, error behavior, and credential handling.
4. Configure the optional Gemini credential only in Anna. Request external API review for `generativelanguage.googleapis.com` before enabling voice; Anna’s manifest accepts HTTPS external origins, while Gemini Live uses a secure WebSocket to the same host.
5. Complete the Marketplace listing, confirm all third-party and adventure content rights, and submit the app for review.

The review process can take up to five business days per submission or resubmission. The founding-builder qualification window currently ends November 30, 2026; the app must be approved and published and reach the announced qualified monthly active user threshold during the window. See the forum announcement for current program terms.

## Release artifacts

The GitHub Actions workflow packages the Executa for these targets:

- `linux-x86_64` as `executas/dnd-game-master/dist/dnd-game-master-{version}-linux-x86_64.tar.gz`
- `darwin-arm64` and `darwin-x86_64` as `.tar.gz`
- `windows-x86_64` as `.zip`

The Linux x86_64 artifact is the required Linux distribution target. Build artifacts and SHA-256 sidecars are emitted under `executas/dnd-game-master/dist/` and attached to version-tagged GitHub releases. Then validate the final app with Anna's CLI before Marketplace submission.

## License

The Anna adaptation code is distributed under the MIT License; see [LICENSE](LICENSE). Third-party campaign text and hosted artwork remain subject to their respective source terms.
