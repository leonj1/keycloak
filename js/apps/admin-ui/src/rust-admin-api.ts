import type KeycloakAdminClient from "@keycloak/keycloak-admin-client";
import type ClientRepresentation from "@keycloak/keycloak-admin-client/lib/defs/clientRepresentation";
import type UserRepresentation from "@keycloak/keycloak-admin-client/lib/defs/userRepresentation";

const pkce = "pkce.code.challenge.method";
const postLogout = "post.logout.redirect.uris";
const device = "oauth2.device.authorization.grant.enabled";
const clientAttributeDefaults: Record<string, string> = {
  "frontchannel.logout.session.required": "true",
  "logout.confirmation.enabled": "false",
  "display.on.consent.screen": "false",
  "backchannel.logout.session.required": "false",
  "backchannel.logout.revoke.offline.tokens": "false",
};

type RustClient = ClientRepresentation & {
  postLogoutRedirectUris?: string[];
  showInAccount?: boolean;
  offlineAccessEnabled?: boolean;
  deviceAuthorizationEnabled?: boolean;
  revocationNotBefore?: number;
};

function toRustUser(user: UserRepresentation, creating: boolean) {
  const emptyValue = creating ? undefined : null;
  if (user.groups?.length || user.requiredActions?.length) {
    throw new Error(
      "Group and required-action assignments are unavailable in this form.",
    );
  }

  const attributes =
    user.attributes &&
    Object.fromEntries(
      Object.entries(user.attributes).flatMap(([name, value]) => {
        const values = (Array.isArray(value) ? value : [value]).filter(
          (entry) => entry !== "" && entry != null,
        );
        return values.length ? [[name, values]] : [];
      }),
    );

  return {
    username: user.username,
    enabled: user.enabled,
    email: user.email === "" ? emptyValue : user.email,
    attributes,
    ...(creating && { credentials: user.credentials }),
  };
}

function fromRustClient(client: RustClient): ClientRepresentation {
  const publicOidc =
    client.protocol === "openid-connect" && client.publicClient;
  return {
    ...client,
    implicitFlowEnabled: false,
    standardFlowEnabled: client.standardFlowEnabled ?? publicOidc,
    attributes: {
      ...(publicOidc && { [pkce]: "S256" }),
      ...client.attributes,
      ...(client.postLogoutRedirectUris && {
        [postLogout]: client.postLogoutRedirectUris.join("##"),
      }),
      ...(client.deviceAuthorizationEnabled !== undefined && {
        [device]: String(client.deviceAuthorizationEnabled),
      }),
    },
  };
}

function toRustClient(client: RustClient, creating: boolean) {
  const emptyValue = creating ? undefined : null;
  const {
    [pkce]: pkceMethod,
    [postLogout]: logoutUris,
    [device]: deviceEnabled,
    ...extraAttributes
  } = client.attributes ?? {};
  const unsupported = Object.entries({
    name: client.name,
    description: client.description,
    rootUrl: client.rootUrl,
    webOrigins: client.webOrigins?.some(Boolean),
    implicitFlowEnabled: client.implicitFlowEnabled,
    directAccessGrantsEnabled: client.directAccessGrantsEnabled,
    authorizationServicesEnabled: client.authorizationServicesEnabled,
    ...extraAttributes,
  })
    .filter(
      ([key, value]) =>
        value !== "" &&
        value !== false &&
        value != null &&
        value !== clientAttributeDefaults[key],
    )
    .map(([key]) => key);
  if (unsupported.length) {
    throw new Error(
      `These client settings are unavailable through the Rust API: ${unsupported.join(", ")}`,
    );
  }

  return {
    clientId: client.clientId,
    enabled: client.enabled,
    protocol: client.protocol,
    publicClient: client.publicClient,
    standardFlowEnabled: client.standardFlowEnabled,
    serviceAccountsEnabled: client.serviceAccountsEnabled,
    redirectUris: client.redirectUris?.filter(Boolean),
    postLogoutRedirectUris:
      typeof logoutUris === "string"
        ? logoutUris.split("##").filter(Boolean)
        : client.postLogoutRedirectUris,
    baseUrl: client.baseUrl === "" ? emptyValue : client.baseUrl,
    consentRequired: client.consentRequired,
    showInAccount: client.showInAccount,
    offlineAccessEnabled: client.offlineAccessEnabled,
    adminUrl: client.adminUrl === "" ? emptyValue : client.adminUrl,
    revocationNotBefore: client.revocationNotBefore,
    deviceAuthorizationEnabled:
      deviceEnabled === undefined
        ? client.deviceAuthorizationEnabled
        : deviceEnabled === true || deviceEnabled === "true",
    attributes: pkceMethod ? { [pkce]: pkceMethod } : undefined,
    ...(creating && { secret: client.secret }),
  };
}

export function configureRustAdminApi(client: KeycloakAdminClient) {
  const {
    create: createUser,
    update: updateUser,
    findOne: findUser,
    getProfileMetadata,
  } = client.users;
  client.users.create = (user, options) =>
    createUser(
      user &&
        ({
          ...toRustUser(user, true),
          ...(user.realm !== undefined && { realm: user.realm }),
        } as UserRepresentation),
      options,
    );
  client.users.update = (params, user) =>
    updateUser(params, toRustUser(user, false) as UserRepresentation);
  client.users.getProfileMetadata = async (...args) => {
    const metadata = await getProfileMetadata(...args);
    return {
      ...metadata,
      attributes: metadata.attributes?.filter(({ name }) => name !== "id"),
    };
  };
  client.users.findOne = async (params, options) => {
    const user = await findUser(params, options);
    if (user && params?.userProfileMetadata) {
      return {
        ...user,
        userProfileMetadata: await client.users.getProfileMetadata(
          params.realm === undefined ? undefined : { realm: params.realm },
        ),
      };
    }
    return user;
  };

  const {
    create: createClient,
    update: updateClient,
    findOne: findClient,
  } = client.clients;
  client.clients.create = (input, options) =>
    createClient(
      input &&
        ({
          ...toRustClient(input, true),
          ...(input.realm !== undefined && { realm: input.realm }),
        } as ClientRepresentation),
      options,
    );
  client.clients.update = (params, input) =>
    updateClient(params, toRustClient(input, false) as ClientRepresentation);
  client.clients.findOne = async (...args) => {
    const result = await findClient(...args);
    return result && fromRustClient(result);
  };
}
