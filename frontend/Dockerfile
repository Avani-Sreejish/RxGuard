FROM node:22-alpine AS build
# Some networks block registry.npmjs.org; pass --build-arg NPM_REGISTRY=<mirror> if needed.
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=${NPM_REGISTRY}
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1/nginx-health || exit 1
