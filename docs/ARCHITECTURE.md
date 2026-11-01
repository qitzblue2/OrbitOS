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

## Desktop app (`app/`)

```
renderer (dashboard)              main process                         speech process (utilityProcess)
 mic ─► AudioWorklet 16 kHz ─IPC─► forwards audio while listening ─► KeywordSpotter "hey orbit"
                                                                       └ wake ─► streaming STT ─► text
 plays on-device voice ◄────IPC── synthesize sentence by sentence ◄── Piper TTS
 sends text ─► embedded ORBIT server ─► engine ─► built-in Companion (this computer)
 tray · Alt+Space push-to-talk · overlay window · start at login
```

- **Process isolation:** the speech engine runs in a separate process and restarts by itself if it ever stops.
- **No self-wake:** while ORBIT is speaking, its own voice isn't fed to the wake detector. Talking over it interrupts it (barge-in), and ORBIT listens for 8 seconds after each reply without needing the wake word.
- **Microphone permission:** only ORBIT's own local pages may use the microphone. On macOS the app asks for microphone access on first launch.
- **Models:** bundled inside the installers. When running from source, `npm run models` fetches them.

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
| Wake word | **Built, in the app:** "Hey Orbit" and "OK Orbit" are detected on-device by an open-vocabulary keyword spotter (sherpa-onnx, 3.3M parameters). It runs in its own process, with adjustable sensitivity. In the browser-only dashboard it still uses the browser's recognizer. | Test against more real voices and accents; offer a custom wake phrase in settings. |
| Voice activity, end of speech, barge-in | Local VAD with an adaptive noise floor, silence-based end of turn, and interrupt on speech. | Move to WebRTC VAD or Silero inside the native app. |
| Speech to text / text to speech | **App:** on-device streaming recognition (zipformer, 20M parameters) with automatic end of turn, and an on-device neural voice (Piper). A 1.2 s audio buffer keeps the first words after the wake phrase. Common misspellings and spoken numbers are corrected before parsing. The browser falls back to browser engines. | Optional cloud voices (for example ElevenLabs) for people who prefer them; more voice choices. |
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
