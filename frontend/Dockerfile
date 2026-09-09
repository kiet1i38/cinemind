FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
RUN mkdir -p /usr/share/nginx/html/data
COPY public/data/catalog.json /usr/share/nginx/html/data/catalog.json
COPY public/data/posters /usr/share/nginx/html/data/posters

EXPOSE 5173

CMD ["nginx", "-g", "daemon off;"]
