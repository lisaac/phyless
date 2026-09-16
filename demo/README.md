# Static demo

The demo builds the current `main` frontend with an in-memory API/WebSocket mock. Product source files and the normal `frontend/dist` output are untouched; the Pages build runs from a temporary copy and publishes only generated files to `gh-pages/docs`.

- Push frontend changes to `main`: `.github/workflows/publish-demo.yml` calls the Pages build with that exact commit.
- Change files under `demo/` on `gh-pages`: `.github/workflows/build-demo.yml` rebuilds against the latest `main`.
- To publish, set repository **Settings → Pages → Build and deployment → Deploy from a branch → `gh-pages` / `/docs`** once.
- Run the mock check with `node demo/smoke.test.mjs`; run the complete build with `bash demo/build.sh /path/to/main-checkout /path/to/output`.

The demo has no backend connection. Operations update only in-memory sample data, and refreshing restores the initial state.
