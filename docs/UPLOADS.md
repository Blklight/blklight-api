# Image uploads

`POST /api/v1/uploads?purpose=editor|avatar` takes a multipart field `file` (max 10 MB) and returns
`{ url, width, height, bytes }`.

What the API does with the file (`src/features/uploads/uploads.service.ts`):

- Checks the real format from the file content, not the client's mime type. It accepts JPEG, PNG, WebP, AVIF and GIF. It refuses SVG (it can carry scripts) and HEIC (prebuilt sharp cannot decode it).
- Re-encodes the image as **WebP**, auto-rotates it and drops all metadata (EXIF, including GPS location).
  - `editor`: at most 1920 px wide, never enlarged, quality 80. An animated GIF stays animated.
  - `avatar`: cropped to 512×512 around the most interesting area, quality 82.
- Stores it at `<purpose>/<userId>/<id>.webp` with `Cache-Control: public, max-age=31536000, immutable` and records it in the `uploads` table.

External URLs (imgur etc.) still work everywhere: the image columns stay plain URLs, and an upload only produces one more URL.

The storage is any S3-compatible bucket. The code only reads these env vars, which are the names `fly storage create` sets, so local and Fly run the same code:

| Var | Meaning |
|---|---|
| `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Read by the AWS SDK itself |
| `BUCKET_NAME` | Bucket to write to |
| `UPLOADS_PUBLIC_BASE_URL` | Public URL prefix the returned `url` is built from |
| `FEATURE_UPLOADS` | Default `true`; uploads stay off (503) until `BUCKET_NAME` and `UPLOADS_PUBLIC_BASE_URL` are set |

## Local

1. Start the local S3 (MinIO) and create the public bucket `blklight-dev`:

   ```bash
   docker compose up -d s3 s3-bucket s3-public
   ```

   `s3-bucket` and `s3-public` are one-shot containers: they exit with code 0 once the bucket exists and is publicly readable. Files persist in the `s3_data` volume.

   If your Postgres already runs from another compose project on port 5432, name only these services as above. A bare `docker compose up` would also try to start a second Postgres on the same port.

2. Copy the upload block from `.env.example` into `.env.development`. The defaults match the compose file:

   ```env
   FEATURE_UPLOADS=true
   AWS_ENDPOINT_URL_S3=http://localhost:9000
   AWS_REGION=auto
   AWS_ACCESS_KEY_ID=blklight
   AWS_SECRET_ACCESS_KEY=blklight-dev-secret
   BUCKET_NAME=blklight-dev
   UPLOADS_PUBLIC_BASE_URL=http://localhost:9000/blklight-dev
   ```

3. Run `npm run db:migrate` (creates the `uploads` table), then `npm run dev`.

4. Try it:

   ```bash
   curl -F file=@photo.jpg -H "Authorization: Bearer <access token>" \
     "http://localhost:4000/api/v1/uploads?purpose=editor"
   ```

   Open the returned `url` in the browser. To list what is stored:

   ```bash
   docker run --rm --network host -e MC_HOST_local=http://blklight:blklight-dev-secret@localhost:9000 \
     cgr.dev/chainguard/minio-client:latest ls --recursive local/blklight-dev
   ```

The frontend needs `NEXT_PUBLIC_UPLOADS_URL=http://localhost:9000` so its CSP allows these images over plain http.

Why Chainguard's image: the official `minio/minio` image stopped being published on Docker Hub in October 2025. `cgr.dev/chainguard/minio` is a free build of the same server. Any S3-compatible server (e.g. `pgsty/silo`) works the same way.

## Deploying on Fly.io (guide, not set up yet)

Nothing in the repo deploys to Fly yet. These are the steps when the time comes.

### 1. Dockerfile

`node:24-slim` uses glibc, so it runs sharp's prebuilt binary. Alpine (musl) needs extra care.

```dockerfile
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
EXPOSE 4000
CMD ["node", "dist/http/server.js"]
```

`drizzle-kit` is a devDependency, and the release command below needs it. Either move it to `dependencies` or run migrations from the build stage image.

### 2. App

```bash
fly launch --no-deploy        # pick region gru (São Paulo); it writes fly.toml
```

In `fly.toml`:

```toml
[http_service]
  internal_port = 4000

[[vm]]
  memory = "512mb"            # sharp needs headroom; 256mb is too tight for large photos

[deploy]
  release_command = "npm run db:migrate"
```

Set the usual secrets: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `CORS_ORIGIN`, `TRUST_PROXY`, and so on.

### 3. Storage (Tigris)

```bash
fly storage create --public
```

This creates a Tigris bucket and sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` and `BUCKET_NAME` as app secrets. No code changes are needed. Then:

```bash
fly secrets set UPLOADS_PUBLIC_BASE_URL=https://<bucket>.fly.storage.tigris.dev
fly deploy
```

On the frontend, set `NEXT_PUBLIC_UPLOADS_URL=https://<bucket>.fly.storage.tigris.dev`. The CSP already allows any `https:` image.

### 4. Before deploying, check

- **Postgres:** the API uses pgvector (memory feature). Confirm the Fly Postgres offering you pick supports the `vector` extension.
- **Cost:** Tigris bills through the Fly invoice. At the time of writing the free allowance is 5 GB storage and 10,000 uploads/month, with no egress fees, then about $0.02/GB/month. Check the current numbers on <https://www.tigrisdata.com/pricing/>.
