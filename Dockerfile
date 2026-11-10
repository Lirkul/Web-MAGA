FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=UTC

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node

EXPOSE 3000

CMD ["npm", "start"]
