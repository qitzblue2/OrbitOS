# ORBIT

A voice-first personal AI system. You talk to it ("Hey Orbit, start my gaming setup") and it runs your computers, smart home and information, with a clear permission model and an audit trail.

![ORBIT dashboard](docs/screenshots/dashboard.png)

ORBIT has three parts:

| Part | Folder | What it does |
|---|---|---|
| **Server** | `server/` | The intent router, the execution engine, the AI brain, memory, the device hub, smart home, automations and security. |
| **Dashboard** | `web/` | The animated ORBIT core, the voice engine and nine control screens. It works on desktop and phone widths. |
| **ORBIT Companion** | `companion/` | A small agent you install on each computer. ORBIT acts on a machine only through its Companion, within the permissions you grant. |

## Quick start

You need Node 20 or newer.

```bash
npm install
```

```bash
cp .env.example .env
```

Add `ANTHROPIC_API_KEY` to `.env` if you want ORBIT to answer open questions. Without a key, device control, routines, memory and the smart home still work. Questions get an honest "not connected" reply.

```bash
npm start
```

Open the printed URL and paste the dashboard token, which is also saved in `data/admin-token`.

To pair a computer, open **Devices** and select **Pair a new device**. Then, on that computer:

```bash
node companion/agent.js pair http://<orbit-host>:7777 <code> "My laptop"
```

```bash
node companion/agent.js
```

Then try a command: hold Space and say "open Spotify", or turn the mic on and say "Hey Orbit, lock my computer". Locking is off by default; grant it in **Security**.

## What happens when you speak

1. **Hear.** The browser voice engine detects the wake phrase or push-to-talk. Local voice-activity detection drives the core, end-of-speech detection and barge-in.
2. **Understand.** `server/intents.js` parses common commands locally, in microseconds, with no AI call.
3. **Route.** A command becomes an action. A question goes to the brain: the fast model for simple questions, the reasoning model for analysis, code, plans and screenshots.
4. **Resolve the target.** "On my gaming PC" picks a device by name or platform.
5. **Check permission.** The capability must be granted to that device on the server, and also allowed by the device's own local policy.
6. **Confirm.** Sensitive capabilities (messages, shutdown, commands) wait for "yes".
7. **Execute and verify.** The Companion runs the action and acknowledges it. ORBIT reports success only after that acknowledgement. A failure or silence is said plainly.
8. **Reply and log.** ORBIT gives a short spoken reply, streamed sentence by sentence, and writes an audit entry.

Measured on the dev box: greeting 1 ms, smart home 1 ms, a device status round trip 5 ms. That is well under the 300 ms target.

## Examples that work today

- **Devices:** "open Spotify and play my music", "turn my volume down", "set volume to 40", "open Chrome and search for today's news", "lock my computer", "take a screenshot", "why isn't this working?" (screenshot plus AI analysis), "device status", "turn on my computer" (Wake-on-LAN).
- **Home:** "turn off all the lights", "set my room lighting to 30 percent", "what's the temperature in my room?", "set the thermostat to 21".
- **Routines:** "activate movie mode", "start my gaming setup", "launch my development environment", "start goodnight mode". You can edit them under **Automations**.
- **Memory:** "remember that my sister is called Maya", "forget that…". You can review, edit and delete memories under **Memory**.
- **Proactive:** "good morning" gives a briefing. Reminders fire as notifications and are spoken.

## Tests

```bash
npm test
```

15 tests cover the intent parser and the full server path:
- pairing
- authentication
- device commands over WebSocket
- honest failure and timeout replies
- permission enforcement
- confirmation of sensitive actions
- routines
- the memory sensitivity guard
- revocation

## Status

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map and for what is built versus planned.
