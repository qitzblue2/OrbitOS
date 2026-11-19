// Spotify control through the Spotify Web API (PKCE sign-in: only your own app's Client ID is needed,
// no secret). Playback control needs Spotify Premium. Tokens are kept in an owner-only file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SPOTIFY_REDIRECT = 'http://127.0.0.1:7777/spotify';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read playlist-read-private';
const b64url = (b) => b.toString('base64url');

export class Spotify {
  constructor(dir, fetchImpl = fetch) {
    this.file = path.join(dir, 'spotify.json'); this.fetch = fetchImpl;
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 }); }
  get connected() { return !!this.data.refreshToken; }
  status() { return { connected: this.connected, clientId: this.data.clientId || '', user: this.data.user || '' }; }
  disconnect() { this.data = { clientId: this.data.clientId }; this.save(); }

  start(clientId) {
    if (!/^[0-9a-f]{32}$/i.test(String(clientId || '').trim())) throw new Error('That doesn\'t look like a Spotify Client ID (32 letters and numbers).');
    const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(12));
    Object.assign(this.data, { clientId: clientId.trim(), verifier, state }); this.save();
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({ client_id: this.data.clientId, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT, code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state });
    return { url: `https://accounts.spotify.com/authorize?${q}`, redirect: SPOTIFY_REDIRECT };
  }
  // Accepts the full address Spotify sent the browser to (or just the code).
  async finish(addressOrCode) {
    const raw = String(addressOrCode || '').trim();
    let code = raw, state = null;
    try { const u = new URL(raw); code = u.searchParams.get('code'); state = u.searchParams.get('state'); if (u.searchParams.get('error')) throw new Error(`Spotify said: ${u.searchParams.get('error')}`); } catch (e) { if (e.message.startsWith('Spotify')) throw e; }
    if (!code) throw new Error('No code found. Paste the whole address from the browser after approving.');
    if (state && state !== this.data.state) throw new Error('That sign-in link is old. Start again.');
    await this.token({ grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT, client_id: this.data.clientId, code_verifier: this.data.verifier });
    delete this.data.verifier; delete this.data.state;
    try { const me = await this.api('GET', '/me'); this.data.user = me?.display_name || me?.id || ''; } catch {}
    this.save();
    return this.status();
  }
  async token(form) {
    const r = await this.fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || `Spotify sign-in failed (${r.status})`);
    this.data.accessToken = j.access_token; this.data.expiresAt = Date.now() + (j.expires_in - 60) * 1000;
    if (j.refresh_token) this.data.refreshToken = j.refresh_token;
    this.save();
  }
  async api(method, p, body) {
    if (!this.connected) throw Object.assign(new Error('Spotify isn\'t connected yet. Connect it under Settings.'), { code: 'NOT_CONNECTED' });
    if (!this.data.accessToken || Date.now() > this.data.expiresAt) await this.token({ grant_type: 'refresh_token', refresh_token: this.data.refreshToken, client_id: this.data.clientId });
    const r = await this.fetch(`https://api.spotify.com/v1${p}`, { method, headers: { authorization: `Bearer ${this.data.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = j?.error?.message || `Spotify error ${r.status}`;
      if (r.status === 403 && /premium/i.test(msg)) throw new Error('Controlling playback needs Spotify Premium.');
      if (r.status === 404 && /device/i.test(msg)) throw new Error('No Spotify device is active. Open Spotify on your phone, computer or speaker first.');
      throw new Error(msg);
    }
    return j;
  }
  async device(hint) {
    const { devices = [] } = await this.api('GET', '/me/player/devices') || {};
    if (hint) { const h = hint.toLowerCase(); const d = devices.find((x) => x.name.toLowerCase().includes(h)); if (d) return d; }
    return devices.find((d) => d.is_active) || devices[0] || null;
  }
  async play({ query, kind, hint }) {
    const type = { song: 'track', track: 'track', playlist: 'playlist', album: 'album', artist: 'artist' }[kind] || 'track,artist,playlist';
    const res = await this.api('GET', `/search?limit=1&type=${type}&q=${encodeURIComponent(query)}`);
    const pick = kind ? res?.[`${type}s`]?.items?.[0]
      : res?.artists?.items?.[0]?.name?.toLowerCase() === query.toLowerCase() ? res.artists.items[0]
      : res?.tracks?.items?.[0] || res?.playlists?.items?.find(Boolean) || res?.artists?.items?.[0];
    if (!pick) return { ok: false, say: `I couldn't find ${query} on Spotify.` };
    const dev = await this.device(hint);
    if (!dev) return { ok: false, say: 'No Spotify device is available. Open Spotify on your phone, computer or speaker first.' };
    const body = pick.type === 'track' ? { uris: [pick.uri] } : { context_uri: pick.uri };
    await this.api('PUT', `/me/player/play?device_id=${dev.id}`, body);
    const what = pick.type === 'track' ? `${pick.name} by ${pick.artists?.[0]?.name}` : pick.name;
    return { ok: true, say: `Playing ${what}${hint || !dev.is_active ? ` on ${dev.name}` : ''}.` };
  }
  async liked({ hint }) {
    const j = await this.api('GET', '/me/tracks?limit=50');
    const uris = (j?.items || []).map((i) => i.track?.uri).filter(Boolean).sort(() => Math.random() - 0.5);
    if (!uris.length) return { ok: false, say: 'You don\'t have any liked songs yet.' };
    const dev = await this.device(hint);
    if (!dev) return { ok: false, say: 'No Spotify device is available. Open Spotify somewhere first.' };
    await this.api('PUT', `/me/player/play?device_id=${dev.id}`, { uris });
    return { ok: true, say: `Playing your liked songs${!dev.is_active || hint ? ` on ${dev.name}` : ''}.` };
  }
  async control(action) {
    const map = { play: ['PUT', '/me/player/play'], pause: ['PUT', '/me/player/pause'], next: ['POST', '/me/player/next'], previous: ['POST', '/me/player/previous'] };
    const [m, p] = map[action] || map.play;
    await this.api(m, p);
    return { ok: true, say: { play: 'Playing.', pause: 'Paused.', next: 'Next song.', previous: 'Previous song.' }[action] };
  }
  async now() {
    const j = await this.api('GET', '/me/player/currently-playing');
    if (!j?.item) return { ok: true, say: 'Nothing is playing on Spotify.' };
    return { ok: true, say: `This is ${j.item.name} by ${j.item.artists?.map((a) => a.name).join(' and ')}.` };
  }
}
