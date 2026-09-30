# PromptForge

PromptForge is a single-page creative AI workshop powered by a local
MoneyPrinterTurbo API. The browser talks only to the Express app. Express
submits video generation requests, polls task status, proxies completed media,
and keeps provider API keys on the server.

## Requirements

- Node.js 18 or newer
- MoneyPrinterTurbo running with its REST API enabled
- MoneyPrinterTurbo configured with the LLM, TTS, and media providers you need
- A Pollinations API key if you want image generation

MoneyPrinterTurbo's API documentation is typically available from the running
service at `http://127.0.0.1:8080/docs`.

## Install

```bash
npm install
```

Copy `.env.example` to `.env` and adjust the values:

```env
MPT_API_URL=http://127.0.0.1:8080
MPT_API_KEY=
POLLINATIONS_API_KEY=
PORT=3000
```

Then start the app:

```bash
npm start
```

Open `http://localhost:3000`.

For development, use:

```bash
npm run dev
```

## Features

- Video generation through MoneyPrinterTurbo
- Image generation through Pollinations, with the key kept server-side
- Portrait (9:16), landscape (16:9), and square (1:1) formats
- Image style, lighting, and detail controls
- Optional video subtitles
- Live engine connection state
- Task progress polling and timeout handling
- Downloadable generated video or image
- Responsive dark/light studio UI
- Accessible keyboard focus states and reduced-motion support

## Notes

The application is intentionally a server-rendered static frontend served by
Express. GitHub Pages cannot run the Express API, so deploy it to a Node-capable
host if you want the generation features to work remotely.

Never commit your real `.env` file or provider keys.
