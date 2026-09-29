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
