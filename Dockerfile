FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# Database and uploaded ID documents. Mount a volume here to keep them.
ENV DB_FILE=/data/abc-rides.db UPLOAD_DIR=/data/uploads
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
