ARG NODE_VERSION=24.22.0

FROM node:${NODE_VERSION}-bookworm AS build
WORKDIR /app
COPY js/ ./
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm build && chmod -R a+rX apps/admin-ui/dist apps/admin-ui/scripts

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/admin-ui/dist/ ./dist/
COPY --from=build /app/apps/admin-ui/scripts/serve.mjs /app/apps/admin-ui/scripts/console-server.mjs ./scripts/
USER node
EXPOSE 5174
CMD ["node", "scripts/serve.mjs"]
