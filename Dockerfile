FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY standalone ./standalone
COPY dist ./dist
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["npm", "start"]

