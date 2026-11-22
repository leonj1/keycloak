# Keycloak Admin Console for Rust

This fork contains the React Admin Console, its shared UI package, and its TypeScript Admin API client.
It connects to a separately running [Rust identity server](https://github.com/leonj1/keycloak-rs).
The Node host serves the compiled frontend and forwards browser requests to Rust on the same origin so the Rust session cookie works.

## Build and start

Use the Node version in [.node-version](.node-version) and [Corepack](https://github.com/nodejs/corepack).
Corepack selects the pnpm version pinned in [js/package.json](js/package.json).
The first build downloads the pinned Kiota generator for the checked-in Admin API schema.

Start Rust and bootstrap a service administrator using the instructions in the Rust repository.
Run Rust with its HTTP application path at `/`.
Then, from this repository:

```sh
cd js
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

Open [http://localhost:5174](http://localhost:5174/) and sign in with your administrator client ID and secret.
Rust validates the credentials and issues the browser session cookie.
For local development, rerun the build after changing the frontend.
The Node host reads the new build from `js/apps/admin-ui/dist/`.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `RUST_SERVER_URL` | `http://127.0.0.1:8080` | Rust application listener reachable from the Node host |
| `RUST_PUBLIC_ORIGIN` | Value of `RUST_SERVER_URL` | Origin configured as `PUBLIC_ORIGIN` in Rust |
| `CONSOLE_ORIGIN` | `http://localhost:<PORT>` | Exact origin the browser uses, including scheme and port |
| `PORT` | `5174` | Node host port |
| `ADMIN_REALM` | `master` | Realm used for administrator sign-in |

The listener binds to `0.0.0.0`.
For a deployed console, terminate HTTPS at a reverse proxy, preserve the public `Host` header, and configure the console and Rust public origins for HTTPS.
Keep the generated files and the Node host together when deploying.

## Run with Docker

From the repository root, build the image and start the container.

```sh
docker build -t keycloak-admin-console .
docker run --rm --init -p 5174:5174 \
  --add-host=host.docker.internal:host-gateway \
  -e RUST_SERVER_URL=http://host.docker.internal:8080 \
  -e RUST_PUBLIC_ORIGIN=http://localhost:8080 \
  keycloak-admin-console
```

This example assumes Rust listens on port `8080` on an interface reachable from Docker and uses `http://localhost:8080` as `PUBLIC_ORIGIN`.
If Rust runs in another container, attach both containers to the same Docker network and use the Rust container name in `RUST_SERVER_URL`.
Set `RUST_PUBLIC_ORIGIN` to the value configured in Rust and `CONSOLE_ORIGIN` to the address you open in the browser.
With the example above, open [http://localhost:5174](http://localhost:5174/).

## Verify

Run the same checks as CI from `js/` after building:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:proxy
```

The browser test checks the console against a live Rust server and removes its disposable user and client records.
Start the frontend as above, then run:

```sh
corepack pnpm --filter @keycloak/keycloak-admin-ui exec playwright install chromium
ADMIN_CLIENT_ID=your-test-admin \
  ADMIN_CLIENT_SECRET_FILE=/path/to/test-admin-secret \
  corepack pnpm test:browser
```

Set `CONSOLE_ORIGIN` and `ADMIN_REALM` for the browser test if you changed them when starting the frontend.
The acceptance coverage is Rust v0.1.0 sign-in, user and public OIDC client management, and sign-out.
Some inherited screens expose options outside the Rust v0.1.0 API contract, including user required-action assignments and advanced client settings.

See [FRONTEND_PLAN.md](FRONTEND_PLAN.md) for each migration gate and its result.
