(() => {
  const account = document.getElementById("account-console");
  const config = document.currentScript?.dataset.config;
  const request = globalThis.request;
  if (!account?.dataset.api || !config || typeof request !== "function") return;

  const { mcpUrl, providers } = JSON.parse(config);
  const accountUrl = new URL(account.dataset.api, window.location.href);
  const applicationsUrl = `${accountUrl.origin}${accountUrl.pathname}/applications`;
  const section = element("section");
  section.id = "ai-integrations";
  section.setAttribute("aria-labelledby", "ai-integrations-title");
  const heading = element("h2", "AI integrations");
  heading.id = "ai-integrations-title";
  const message = element("p");
  message.setAttribute("role", "status");
  message.className = "status";
  const refresh = button("Refresh access status");
  section.append(
    heading,
    element(
      "p",
      "Finish setup in the provider, then sign in with your own realm account and approve access. Your account needs the mcp-operator realm role.",
    ),
    element(
      "p",
      "If a client secret is required, the connector installer must obtain it through the administrator’s approved channel.",
    ),
    element(
      "p",
      "Access status reflects your Keycloak consent. Check the provider to see whether the connector is installed and working.",
    ),
    refresh,
    message,
  );

  const cards = providers.map(([name, clientId]) => {
    const title = element("h3", name);
    title.id = `ai-integrations-${name.toLowerCase()}`;
    const card = element("section");
    card.setAttribute("aria-labelledby", title.id);
    const access = element("p", "Checking access…");
    const revoke = button("Revoke access");
    revoke.setAttribute("aria-label", `Revoke access for ${name}`);
    revoke.hidden = true;
    revoke.addEventListener("click", () => revokeAccess(name, clientId));
    const instructions =
      name === "Claude"
        ? "Add a custom connector in Claude. Choose “Sign in now” and “Use your own OAuth client.”"
        : "Add a custom MCP server in ChatGPT and select OAuth with the pre-registered client. Give your administrator the exact redirect URI shown in the setup screen for the client registration.";
    card.append(
      title,
      element("p", instructions),
      copyField(name, "MCP URL", mcpUrl),
      copyField(name, "OAuth client ID", clientId),
      access,
      revoke,
    );
    section.append(card);
    return { clientId, access, revoke };
  });
  account.append(section);
  const link = element("a", "AI integrations");
  link.href = "#ai-integrations";
  account.querySelector("nav")?.append(link);

  let busy = false;
  refresh.addEventListener("click", async () => {
    if (busy) return;
    message.textContent = "";
    setBusy(true);
    await loadAccess();
    setBusy(false);
  });
  if (accountUrl.origin === window.location.origin) {
    refresh.click();
  } else {
    setBusy(true);
    renderAccess();
    message.textContent =
      "Your administrator must serve account settings and the account API on the same origin to manage access.";
  }

  function element(tag, text = "") {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function button(label) {
    const node = element("button", label);
    node.type = "button";
    return node;
  }

  function copyField(name, label, value) {
    const wrapper = element("p");
    const field = element("input");
    field.readOnly = true;
    field.value = value;
    const fieldLabel = element("label", label);
    fieldLabel.append(field);
    const copy = button(`Copy ${label}`);
    copy.setAttribute("aria-label", `Copy ${label} for ${name}`);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(value);
        message.textContent = `${name} ${label} copied.`;
      } catch {
        field.focus();
        field.select();
        message.textContent = `Copy the selected ${label}.`;
      }
    });
    wrapper.append(fieldLabel, copy);
    return wrapper;
  }

  function setBusy(value) {
    busy = value;
    refresh.disabled = value;
    for (const { revoke } of cards) revoke.disabled = value;
  }

  function renderAccess(applications) {
    for (const { clientId, access, revoke } of cards) {
      const entry = applications?.find((app) => app.clientId === clientId);
      const granted =
        Array.isArray(entry?.grantedScopes) && entry.grantedScopes.length > 0;
      access.textContent = applications
        ? granted
          ? "Access granted"
          : "No access granted"
        : "Access status unavailable";
      revoke.hidden = !granted;
    }
  }

  async function loadAccess() {
    try {
      const applications = await request(applicationsUrl);
      if (!Array.isArray(applications))
        throw new Error("Expected an application list");
      renderAccess(applications);
    } catch {
      renderAccess();
      const loadError =
        "Could not load access status. Make sure you are signed in and refresh the status to try again.";
      message.textContent = [message.textContent, loadError]
        .filter(Boolean)
        .join(" ");
    }
  }

  async function revokeAccess(name, clientId) {
    if (busy) return;
    setBusy(true);
    message.textContent = "";
    try {
      const result = await request(
        `${applicationsUrl}/${encodeURIComponent(clientId)}/consent`,
        "DELETE",
      );
      // The built-in account client returns undefined for a 204 response.
      if (result !== undefined) throw new Error("Expected a 204 response");
      message.textContent = `Access revoked for ${name}. You can also remove the connector in ${name}.`;
      renderAccess();
      await loadAccess();
    } catch {
      message.textContent = `Could not revoke access for ${name}. Refresh the access status and try again.`;
    } finally {
      setBusy(false);
    }
  }
})();
