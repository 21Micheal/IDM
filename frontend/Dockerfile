FROM node:20-alpine AS development

WORKDIR /app

# Copy manifests first so this layer is cached unless deps change
COPY package.json package-lock.json* ./

# Install all dependencies inside the container
RUN npm install

# Copy source after install so node_modules stays in image layer
COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"]

# ── Production build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# API base URL baked into the bundle. Empty (the default) makes the SPA call a
# relative /api/v1, i.e. same-origin — correct when nginx serves the SPA and
# proxies the API. Set a value only for a split-origin deployment. This ENV
# takes precedence over any committed .env.local during the build.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:alpine AS production
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]