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
| `ACCOUNT_AI_INTEGRATIONS` | Unset | Public connector configuration for one realm, described in [AI integrations](#ai-integrations) |

The listener binds to `0.0.0.0`.
For a deployed console, terminate HTTPS at a reverse proxy, preserve the public `Host` header, and configure the console and Rust public origins for HTTPS.
Keep the generated files and the Node host together when deploying.

## AI integrations

Use a Rust server build with [MCP support](https://github.com/leonj1/keycloak-rs/blob/6887df98fe39c8c74a2a31154b0371abe4c2cd0a/docs/mcp.md).
Enable MCP for one non-master realm, assign eligible users the `mcp-operator` realm role, and register a separate public OIDC client for each connector.
Enable `consentRequired` and `showInAccount` on each registration so users can revoke their consent in account settings.
Allow the exact redirect URI from each provider and configure the connector client UUIDs and any secrets on Rust as described in its MCP guide.
Administrators control the registrations, role assignments, and `MCP_WRITES_ENABLED`.

Set `ACCOUNT_AI_INTEGRATIONS` on the **Node host** before starting it.
Use the same realm as Rust's `MCP_REALM`, the exact public HTTPS MCP endpoint, and each connector registration's public `clientId`.
Omit a provider from `providers` when it is unavailable in that realm.

```sh
export ACCOUNT_AI_INTEGRATIONS='{"realm":"demo","mcpUrl":"https://identity.example.com/auth/mcp","providers":{"Claude":"claude-mcp","ChatGPT":"chatgpt-mcp"}}'
```

This configuration is visible to browsers.
Store any connector secret in the administrator's secret store and share it with the connector installer through the approved channel.

Serve the account page and the account API on a single HTTPS origin so browser sign-in and consent revocation can use the realm session cookie.
If the Node frontend and Rust are on different public origins, route the account frontend and its API through the same public origin before enabling the section.
Set `CONSOLE_ORIGIN` to that browser-facing origin and `RUST_PUBLIC_ORIGIN` to Rust's `PUBLIC_ORIGIN`.
Preserve the public `Host` when forwarding to the Node host.
The Node host keeps the base path from the MCP URL when it forwards account routes to Rust.

When using an HTTPS reverse proxy in front of both services, route `<basePath>/realms/<realm>/account` and its subpaths, `<basePath>/resources/v1/account/`, `<basePath>/welcome-content/`, and `<basePath>/account-ai-integrations.js` to the Node host without stripping the base path.
Route the MCP endpoint, OAuth endpoints, and origin-level `/.well-known/` discovery to Rust as described in its MCP guide.
On the example deployment, visit `https://identity.example.com/auth/realms/demo/account`, sign in as a realm user, and select **AI integrations**.

### Staging smoke test

Use a staging realm user with `mcp-operator` and run each provider flow independently.
Start without a prior consent for the provider under test.
Verify the provider's setup instructions, copied MCP URL and client ID, and initial **No access granted** status in account settings.

1. Add a custom connector in **Claude** with the copied MCP URL.
   Choose **Sign in now** and **Use your own OAuth client**, then enter the pre-registered client ID and any required secret.
   Sign in to Keycloak with the staging user's realm credentials and approve consent.
   Enable the connector in a conversation and call `get_realm` to verify that it returns the staging realm. [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
2. Add a custom MCP server in **ChatGPT** on the web with the copied URL and select **OAuth**, using the pre-registered client ID and any required secret.
   Verify that the administrator has registered the exact redirect URI shown by ChatGPT.
   Install the plugin, sign in to Keycloak as the staging realm user, and approve consent.
   Select the plugin in a conversation and call `get_realm` to verify that it returns the staging realm. [ChatGPT custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server) · [ChatGPT OAuth redirect URIs](https://developers.openai.com/plugins/build/auth#redirect-url)

For each provider, return to account settings and select **Refresh access status**.
Verify **Access granted**, select **Revoke access** for that provider, and check for the success message and **No access granted** after the list refreshes.
Leave the connector installed and retry `get_realm` through that same connection without signing in or approving access again.
Verify that the previous grant cannot call the tool and that the provider reports an authorization failure or requires a fresh sign-in.
Remove the connector in the provider if desired.

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
