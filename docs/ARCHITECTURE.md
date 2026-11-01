# ORBIT architecture

```
 voice / text ─► Dashboard (web/) ──WebSocket /ws/ui──► Server (server/)
                 core.js  voice.js                     ├─ intents.js       local parser (no AI)
                                                       ├─ engine.js        route → permit → confirm → execute → verify
                                                       ├─ brain/           provider-agnostic AI, fast/reasoning tiers
                                                       ├─ memory.js        permanent memories + temporary context
                                                       ├─ devices.js       pairing, hashed tokens, permissions, revoke
                                                       ├─ smarthome/       Home Assistant · Hue · simulator
                                                       ├─ automations.js   routines + reminders
                                                       └─ audit.js         append-only action log
                                        ◄──WebSocket /ws/device── ORBIT Companion (companion/agent.js)
```

Every module sits behind a small interface, so each can be replaced on its own. For example, the brain's providers share one `stream()` generator, and memory exposes `recall(query)`.

## Security model

- **Secrets:** API keys live only in the server's `.env` and never reach the dashboard. The dashboard uses its own access token.
- **Device credentials:** each Companion gets its own 256-bit token through a single-use, 10-minute pairing code. Only a SHA-256 hash is stored. Revoking a device closes its connection at once and kills its token.
- **Two permission layers:** capabilities are granted per device on the server. The machine's owner can also deny capabilities locally in `~/.orbit-companion.json`. Apps, folders, commands and workflows are allow-listed. Commands run with `execFile` and argument arrays, never through a shell.
- **Confirmations and verification:** sensitive capabilities need a confirmation. Success is reported only after the device acknowledges the action; a timeout counts as "can't say it worked".
- **Screenshots:** they are taken only on request, sent once, and deleted from the device. The server never stores them.
- **Memory:** it refuses text that looks like a password, card number or key unless you confirm. Conversation context lives in RAM only.
- **Audit and headers:** an audit log records device actions, pairing, permission changes and revocations. The dashboard is served with a strict Content-Security-Policy.
- **Network:** run behind HTTPS (for example Caddy or Tailscale) when you expose ORBIT beyond localhost. WebSockets then use `wss://`.

## Built vs. planned

| Area | Built now | Next step |
|---|---|---|
| Wake word | "Hey Orbit" through browser speech recognition. It is opt-in and labelled, because Chrome's recognizer is cloud-based. | A native, fully local wake word (openWakeWord or Porcupine) in the Companion. Only the audio after the wake word leaves the device. |
| Voice activity, end of speech, barge-in | Local VAD with an adaptive noise floor, silence-based end of turn, and interrupt on speech. | Move to WebRTC VAD or Silero inside the native app. |
| Speech to text / text to speech | Browser engines. Text-to-speech streams sentence by sentence while the model is still writing. | Pluggable streaming providers (for example Deepgram STT, ElevenLabs or Cartesia TTS) behind a `speech/` interface. |
| AI | Anthropic streaming, fast and reasoning tiers, web search for current-events questions, vision for screenshots, and an honest offline mode. The provider can be switched at runtime. | More providers (OpenAI-compatible or local Ollama), using the same `stream()` signature. |
| Memory | JSON store with keyword-plus-recency recall, plus a CRUD UI. | Embeddings and SQLite/pgvector behind the same `recall()` call. |
| Companion | Windows, macOS and Linux: apps, volume, media, screenshots, lock, shutdown, status, notifications, approved folders, commands and workflows. Wake-on-LAN through the MAC address the Companion reports. | Packaged tray apps with auto-start. |
| Phones | The protocol is documented below. Android can run the Node agent today under Termux. | A native Android app (Accessibility, MediaSession, notifications) and an iOS app limited to what Apple permits (Shortcuts and App Intents; no unrestricted background control). |
| Smart home | Home Assistant (lights, temperature, thermostat, scenes), Philips Hue, and a simulator that labels itself in every reply. | More scenes, cameras and sensor alerts through Home Assistant. |
| Proactive | Spoken greeting and briefing, reminders, device-offline alerts. | A calendar connector and scheduled briefings. |

## Companion protocol (for native apps)

1. Pair by sending `POST /api/pair {code, name, platform}`. The reply is `{token, device}`.
2. Connect with `wss://host/ws/device` and the header `Authorization: Bearer <token>`.
3. The server sends `{"type":"command","id","capability","params"}`.
4. The device replies `{"type":"result","id","ok","message","data"}`. It may also send `{"type":"status","status":{...}}` at any time.
5. Close code `4001` means the device was revoked.
