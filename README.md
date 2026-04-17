# Deal Scout

A Vite + React + TypeScript app, wired for zero-click deployment to Google Cloud Run via Buildpacks. Push to the `main` branch and Cloud Run rebuilds and redeploys automatically. The resulting HTTPS URL is stable across revisions and is designed to be embedded in an iframe on a client site.

## Tech Stack

* Vite 5 (build)
* React 18 + TypeScript
* `serve` (production static server, required by Cloud Run Buildpacks)
* Node 20 LTS (pinned in `engines` and `.nvmrc`)

## Local Development

```bash
npm install
npm run dev
```

To simulate the Cloud Run production start locally:

```bash
npm run build
PORT=8080 npm run start
```

Then open http://localhost:8080.

## Deploying to Cloud Run (One-Time Setup)

This uses Cloud Run's "Continuously deploy from a source repository" option, which wires Cloud Build + Buildpacks to your GitHub repo. No Dockerfile is required.

1. Push this repo to GitHub.
2. Go to Google Cloud Console and open **Cloud Run**.
3. Click **Create Service**.
4. Select **Continuously deploy from a source repository**, then click **Set up with Cloud Build**.
5. Connect GitHub if needed, pick the `deal-scout` repository, and choose the `main` branch.
6. For build type, choose **Go, Node.js, Python, Java, .NET Core, Ruby or PHP via Google Cloud's Buildpacks**. Buildpacks auto-detect Node from `package.json`.
7. Leave the build context at the repo root. No Dockerfile needed.
8. Under **Authentication**, select **Allow unauthenticated invocations** so the iframe can load without a login.
9. Set region (for example `us-central1`), CPU allocation, and memory as desired. Defaults are fine.
10. Click **Create**.

Cloud Build runs, Buildpacks install dependencies with `NODE_ENV=production` (which is why `serve` must be in `dependencies`, not `devDependencies`), runs `npm run build`, and launches `npm run start`. The `start` script binds `serve` to `0.0.0.0:$PORT` so Cloud Run's health check passes.

From now on, every push to `main` triggers a rebuild and redeploy with zero manual steps. The Cloud Run service URL stays the same across revisions, so the iframe embed on the client site never needs to change.

### How Buildpacks Know What To Do

* `package.json` with a `build` script → Buildpacks run `npm run build`.
* `package.json` with a `start` script → Buildpacks run `npm run start`.
* `Procfile` with `web: npm run start` → explicit belt-and-suspenders hint in case autodetection changes.
* `engines.node` in `package.json` and `.nvmrc` → Buildpacks pick Node 20 LTS for a predictable runtime.
* `$PORT` → Cloud Run injects this environment variable (usually `8080`). The `start` script reads it.

## Embedding in a Client Site

Once deployed, Cloud Run gives you an HTTPS URL that looks like:

```
https://deal-scout-abc123-uc.a.run.app
```

Drop this iframe snippet onto the client's site. **Always use the `https://` URL, never `http://`**. Modern browsers block mixed-content iframes, and Cloud Run serves HTTPS only for public URLs anyway.

```html
<iframe
  src="https://deal-scout-abc123-uc.a.run.app"
  title="Deal Scout"
  style="width: 100%; height: 800px; border: 0;"
  loading="lazy"
  allow="clipboard-write"
></iframe>
```

### Iframe Compatibility Notes

This app does not set `X-Frame-Options` or a `Content-Security-Policy` with `frame-ancestors`, so it can be embedded on any origin by default. The production server (`serve`) does not add those headers unless configured to, and nothing in this repo configures them. If you later need to restrict which sites can embed the app, add a `serve.json` with a custom `headers` rule. For now, leave it open so clients can embed without coordination.

The Cloud Run service URL stays stable across revisions, so you can hand a client the iframe snippet once and every future push updates the embedded app automatically.

## Project Structure

```
.
├── Procfile                 Buildpacks start hint
├── index.html               Vite entry HTML
├── package.json             Scripts, deps, engines
├── tsconfig.json            TS project references root
├── tsconfig.app.json        App TS config
├── tsconfig.node.json       Vite config TS config
├── vite.config.ts           Vite build config
├── .gitignore
├── .nvmrc                   Node version for local dev
└── src/
    ├── App.tsx              Main component
    ├── index.css            Global styles
    ├── main.tsx             React entry
    └── vite-env.d.ts        Vite type shims
```

## Why These Choices

* **`serve` in `dependencies`, not `devDependencies`**: Cloud Run Buildpacks install with `NODE_ENV=production`, which skips devDependencies. If `serve` is in devDependencies, the `start` script fails with "command not found."
* **`tcp://0.0.0.0:$PORT`**: Cloud Run health checks hit the container's external interface. Binding to `localhost` or `127.0.0.1` means the health check gets connection refused and the revision never goes live.
* **`engines.node: "20.x"`**: Pins the Buildpack Node runtime to a current LTS so builds are reproducible.
* **No Dockerfile**: Buildpacks pick up `package.json` automatically. Less to maintain.
