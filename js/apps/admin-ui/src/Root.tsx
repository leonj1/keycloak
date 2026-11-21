import { KeycloakProvider } from "@keycloak/keycloak-ui-shared";
import Keycloak from "keycloak-js";
import { App } from "./App";
import { environment } from "./environment";

function createSession() {
  const realm = encodeURIComponent(environment.realm);
  const consolePath = `/admin/${realm}/console`;
  const session = new Keycloak({
    url: environment.serverBaseUrl,
    realm: environment.realm,
    clientId: environment.clientId,
  });
  session.authenticated = true;
  session.idTokenParsed = { preferred_username: environment.administratorName };
  session.updateToken = async () => false;
  session.login = async () => window.location.assign(consolePath);
  session.logout = async () => window.location.assign(consolePath + "/logout");
  session.accountManagement = async () =>
    window.location.assign(`/realms/${realm}/account`);
  return session;
}

const session = createSession();

export const Root = () => (
  <KeycloakProvider environment={environment} keycloak={session}>
    <App />
  </KeycloakProvider>
);
