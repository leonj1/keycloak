import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { waitFor, within } from "@testing-library/dom";
import { JSDOM } from "jsdom";
import { createConsoleServer } from "./console-server.mjs";

async function listen(server, context) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

// Use HTTP directly to model the public Host behind a TLS proxy.
function call(url, { headers, method, body } = {}) {
  return new Promise((resolve, reject) => {
    const connection = request(url, { headers, method }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve(
          new Response(chunks.length ? Buffer.concat(chunks) : null, {
            status: response.statusCode,
            headers: response.headers,
          }),
        );
      } catch (error) {
        reject(error);
      }
    });
    connection.on("error", reject);
    connection.end(body?.toString());
  });
}

test("serves the built console and forwards the Rust session on the configured origin", async (context) => {
  const requests = [];
  const session =
    "kc_admin_console=fixture; Path=/admin/; HttpOnly; SameSite=Strict";
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    const url = new URL(req.url, "http://fixture");
    const writeJson = (body) =>
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    if (url.pathname.endsWith("/login")) {
      return res
        .writeHead(303, {
          "Set-Cookie": session,
          Location: "/admin/team/console",
        })
        .end();
    }
    if (url.pathname.endsWith("/whoami")) {
      if (!req.headers.cookie) return res.writeHead(401).end("Sign in");
      return writeJson({
        id: "123",
        realm: "team",
        username: "team-admin",
        realmAccess: "realm",
      });
    }
    if (url.pathname.endsWith("/messages.json"))
      return writeJson({ clients: "Applications" });
    if (url.pathname === "/admin/serverinfo") {
      return writeJson({
        runtime: { version: "0.1.0" },
        themes: { login: ["builtin"] },
      });
    }
    if (url.pathname.endsWith("/users"))
      return res.writeHead(422).end("Invalid fixture");
    return res.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream, context);
  const publicOrigin = "https://console.example.test";
  const rustPublicOrigin = "https://identity.example.test";
  const frontend = await listen(
    createConsoleServer({
      backendOrigin: upstreamUrl,
      rustPublicOrigin,
      consoleOrigin: publicOrigin,
      realm: "team",
    }),
    context,
  );
  const send = (path, options) => call(frontend + path, options);

  const index = await send("/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /^text\/html/);
  const html = await index.text();
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset);
  const script = await send(asset, { method: "HEAD" });
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /^text\/javascript/);
  assert.match(script.headers.get("cache-control"), /immutable/);
  assert.equal((await send("/missing.js")).status, 404);
  assert.deepEqual(await (await send("/console-config.json")).json(), {
    realm: "team",
  });
  assert.equal((await send("/admin/team/console/whoami")).status, 401);

  const cookie = "kc_admin_console=fixture";
  const authenticated = { headers: { Cookie: cookie } };
  const console = await send("/admin/team/console", authenticated);
  assert.equal(console.status, 303);
  assert.equal(console.headers.get("location"), "/");
  const info = await (await send("/admin/serverinfo", authenticated)).json();
  assert.equal(info.systemInfo.version, "0.1.0");
  assert.deepEqual(info.themes, {
    login: [{ name: "builtin" }],
    account: [],
    admin: [],
    email: [],
  });

  const ownRealm = await (
    await send("/admin/team/console/whoami?currentRealm=team", authenticated)
  ).json();
  assert.equal(ownRealm.displayName, "team-admin");
  assert.equal(ownRealm.createRealm, false);
  assert.ok(ownRealm.realm_access.team.includes("manage-users"));
  const differentRealm = await (
    await send("/admin/team/console/whoami?currentRealm=another", authenticated)
  ).json();
  assert.deepEqual(differentRealm.realm_access, { another: [] });

  const messages = await (await send("/resources/team/admin/en")).json();
  assert.ok(
    messages.some(
      ({ key, value }) => key === "clients" && value === "Applications",
    ),
  );
  assert.ok(messages.length > 1);

  const form = new URLSearchParams({ client_id: "fixture" });
  const originHeaders = {
    Host: new URL(publicOrigin).host,
    Origin: publicOrigin,
  };
  const login = await send("/admin/team/console/login", {
    method: "POST",
    headers: originHeaders,
    body: form,
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("set-cookie"), session);
  assert.equal(login.headers.get("location"), "/admin/team/console");
  assert.equal(requests.at(-1).body, form.toString());
  assert.equal(requests.at(-1).headers.origin, rustPublicOrigin);

  const requestCount = requests.length;
  for (const headers of [
    {},
    { Origin: "https://other.example.test" },
    { Origin: publicOrigin },
  ]) {
    const rejected = await send("/admin/realms/team/users", {
      method: "POST",
      headers,
    });
    assert.equal(rejected.status, 403);
  }
  const crossSiteLogout = await send("/admin/team/console/logout", {
    headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(crossSiteLogout.status, 403);
  assert.equal(requests.length, requestCount);

  const error = await send("/admin/realms/team/users", {
    method: "POST",
    headers: {
      ...originHeaders,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(error.status, 422);
  assert.equal(await error.text(), "Invalid fixture");
  assert.equal(requests.at(-1).headers.cookie, cookie);
});

async function accountFixture(context, basePath, providers) {
  const cookie = "kc_session_team=fixture";
  const rustPublicOrigin = "https://identity.example.test";
  const consoleOrigin = "https://console.example.test";
  const mcpUrl = `${rustPublicOrigin}${basePath}/mcp`;
  const accountPath = `${basePath}/realms/team/account`;
  const nativeScript = `${basePath}/resources/v1/account/builtin/js/console.js`;
  const requests = [];
  const applications = [];
  const upstream = await listen(
    createServer((req, res) => {
      if (req.url === nativeScript) {
        // The native deferred script exposes this cookie-authenticated client.
        return res.writeHead(200, { "Content-Type": "text/javascript" }).end(`
          async function request(url, method = "GET") {
            const response = await fetch(url, { method, headers: { Accept: "application/json" } });
            if (!response.ok) throw new Error("Request failed");
            return response.status === 204 ? undefined : response.json();
          }
        `);
      }
      if (/\/account(?:\/profile|\/security\/sessions)?$/.test(req.url)) {
        const headers = {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "script-src 'self'",
        };
        return res.writeHead(200, headers).end(
          req.headers.cookie === cookie
            ? `<!doctype html><head><script src="${nativeScript}" defer></script></head>
                <div id="account-console" data-api="${accountPath}"><nav aria-label="Account"></nav><h2>Profile</h2></div>`
            : "<h1>Account Console</h1><form><button>Sign in</button></form>",
        );
      }
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
      });
      if (req.headers.cookie !== cookie) return res.writeHead(401).end();
      if (req.url === `${accountPath}/applications` && req.method === "GET") {
        return res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(applications));
      }
      if (req.method === "DELETE" && req.headers.origin === rustPublicOrigin) {
        const index = applications.findIndex(
          ({ clientId }) =>
            req.url ===
            `${accountPath}/applications/${encodeURIComponent(clientId)}/consent`,
        );
        if (index !== -1 && applications[index].clientId === providers.Claude) {
          applications.splice(index, 1);
          return res.writeHead(204).end();
        }
        return res.writeHead(500).end();
      }
      res.writeHead(404).end();
    }),
    context,
  );
  const frontend = await listen(
    createConsoleServer({
      backendOrigin: upstream,
      rustPublicOrigin,
      consoleOrigin,
      accountAiIntegrations: JSON.stringify({
        realm: "team",
        mcpUrl,
        providers,
      }),
    }),
    context,
  );
  const copied = [];
  const page = async (path = accountPath, authenticated = true) => {
    const response = await fetch(frontend + path, {
      headers: {
        Accept: "text/html",
        ...(authenticated && { Cookie: cookie }),
      },
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-security-policy"),
      "script-src 'self'",
    );
    const dom = new JSDOM(await response.text(), {
      url: frontend + path,
      resources: "usable",
      runScripts: "dangerously",
      beforeParse(window) {
        // jsdom loads the deferred scripts but needs a fetch adapter for the
        // browser's same-origin cookie and Origin behavior through the proxy.
        window.fetch = (target, options) => {
          const url = new URL(target, window.location.href);
          assert.equal(url.origin, frontend);
          return call(url, {
            ...options,
            headers: {
              ...options.headers,
              Cookie: cookie,
              Host: new URL(consoleOrigin).host,
              ...(options.method === "DELETE" && { Origin: consoleOrigin }),
            },
          });
        };
        Object.defineProperty(window.navigator, "clipboard", {
          value: { writeText: async (value) => copied.push(value) },
        });
      },
    });
    context.after(() => dom.window.close());
    if (dom.window.document.readyState !== "complete") {
      await once(dom.window, "load");
    }
    return { dom, view: within(dom.window.document.body) };
  };
  return {
    accountPath,
    applications,
    cookie,
    copied,
    consoleOrigin,
    frontend,
    mcpUrl,
    page,
    requests,
    rustPublicOrigin,
  };
}

test("shows configured providers and setup before consent only on the signed-in realm account", async (context) => {
  const clientId = "claude & 'connector'";
  const fixture = await accountFixture(context, "", { Claude: clientId });
  fixture.applications.push(
    { clientId: "another-client", grantedScopes: ["openid"] },
    { clientId, inUse: true, grantedScopes: [] },
  );
  const { view } = await fixture.page();
  assert.ok(view.getByRole("link", { name: "AI integrations" }));
  const claude = within(view.getByRole("region", { name: "Claude" }));
  assert.match(
    claude.getByText(/Use your own OAuth client/).textContent,
    /Sign in now/,
  );
  assert.equal(claude.getByLabelText("MCP URL").value, fixture.mcpUrl);
  assert.equal(claude.getByLabelText("OAuth client ID").value, clientId);
  await claude.findByText("No access granted");
  assert.equal(claude.queryByRole("button", { name: /Revoke access/ }), null);
  assert.equal(view.queryByRole("region", { name: "ChatGPT" }), null);
  claude.getByRole("button", { name: "Copy MCP URL for Claude" }).click();
  claude
    .getByRole("button", { name: "Copy OAuth client ID for Claude" })
    .click();
  assert.deepEqual(fixture.copied, [fixture.mcpUrl, clientId]);

  for (const { view } of [
    await fixture.page("/realms/other/account"),
    await fixture.page(fixture.accountPath, false),
  ]) {
    assert.equal(
      view.queryByRole("heading", { name: "AI integrations" }),
      null,
    );
  }
  assert.deepEqual(
    fixture.requests.map(({ path }) => path),
    [`${fixture.accountPath}/applications`],
  );
});

test("keeps the base path, refreshes consent after 204, and reports failed revocation", async (context) => {
  const fixture = await accountFixture(context, "/identity/auth", {
    Claude: "claude:connector",
    ChatGPT: "chatgpt-mcp",
  });
  fixture.applications.push(
    { clientId: "claude:connector", grantedScopes: ["openid"], inUse: false },
    { clientId: "chatgpt-mcp", grantedScopes: ["openid"], inUse: true },
  );
  const { view } = await fixture.page(
    `${fixture.accountPath}/security/sessions`,
  );
  const claude = within(view.getByRole("region", { name: "Claude" }));
  const chatgpt = within(view.getByRole("region", { name: "ChatGPT" }));
  assert.equal(chatgpt.getByLabelText("MCP URL").value, fixture.mcpUrl);
  assert.ok(chatgpt.getByText(/exact redirect URI shown/));
  await claude.findByText("Access granted");
  await chatgpt.findByText("Access granted");
  const claudeConsent = `${fixture.accountPath}/applications/claude%3Aconnector/consent`;
  const blocked = await call(fixture.frontend + claudeConsent, {
    method: "DELETE",
    headers: {
      Host: new URL(fixture.consoleOrigin).host,
      Origin: "https://other.example.test",
      Cookie: fixture.cookie,
    },
  });
  assert.equal(blocked.status, 403);

  claude.getByRole("button", { name: "Revoke access for Claude" }).click();
  await view.findByText(/Access revoked for Claude.*remove the connector/);
  await claude.findByText("No access granted");
  assert.equal(claude.queryByRole("button", { name: /Revoke access/ }), null);
  const revoke = chatgpt.getByRole("button", {
    name: "Revoke access for ChatGPT",
  });
  await waitFor(() => assert.equal(revoke.disabled, false), {
    container: revoke,
  });
  revoke.click();
  await view.findByText(/Could not revoke access for ChatGPT/);
  assert.ok(chatgpt.getByText("Access granted"));
  assert.equal(revoke.disabled, false);

  const list = `${fixture.accountPath}/applications`;
  assert.deepEqual(
    fixture.requests.map(({ method, path }) => [method, path]),
    [
      ["GET", list],
      ["DELETE", claudeConsent],
      ["GET", list],
      ["DELETE", `${list}/chatgpt-mcp/consent`],
    ],
  );
  for (const { method, headers } of fixture.requests) {
    assert.equal(headers.cookie, fixture.cookie);
    assert.equal(headers.authorization, undefined);
    assert.equal(
      headers.origin,
      method === "DELETE" ? fixture.rustPublicOrigin : undefined,
    );
  }
});

test("rejects connector config outside the public deployment schema", () => {
  const config = {
    realm: "team",
    mcpUrl: "https://identity.example.test/auth/mcp",
    providers: { Claude: "claude-mcp" },
  };
  for (const invalid of [
    { ...config, realm: "master" },
    { ...config, mcpUrl: "http://identity.example.test/auth/mcp" },
    { ...config, mcpUrl: `${config.mcpUrl}?unexpected=value` },
    { ...config, clientSecret: "unused-fixture-value" },
    { ...config, providers: { Claude: { clientId: "claude-mcp" } } },
    { ...config, providers: { Claude: "same-id", ChatGPT: "same-id" } },
  ]) {
    assert.throws(
      () =>
        createConsoleServer({
          backendOrigin: "http://localhost:8080",
          consoleOrigin: "https://identity.example.test",
          accountAiIntegrations: JSON.stringify(invalid),
        }),
      /ACCOUNT_AI_INTEGRATIONS/,
    );
  }
});
