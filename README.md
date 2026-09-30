# PromptForge

PromptForge is a single-page creative video workshop powered by a local
MoneyPrinterTurbo API. The browser talks only to the Express app. Express
submits generation requests, polls task status, and serves completed videos.

## Requirements

- Node.js 18 or newer
- MoneyPrinterTurbo running with its REST API enabled
- MoneyPrinterTurbo configured with the LLM, TTS, and media providers you need

MoneyPrinterTurbo's API documentation is typically available from the running
service at `http://127.0.0.1:8080/docs`.

## Install

```bash
npm install
```


## Image generation

PromptForge now supports both **video** and **image** generation.

Image generation uses the Pollinations image API through the Express backend, so the API key is kept server-side.

Add this to your local `.env`:

```env
POLLINATIONS_API_KEY=your_pollinations_api_key
```

Get a key from Pollinations and restart the Node server after adding it.

The image option supports the same 9:16, 16:9, and 1:1 formats as video.
