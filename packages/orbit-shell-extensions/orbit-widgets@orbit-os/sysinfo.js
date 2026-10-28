// Pure helpers (no Shell imports) so they can be unit-tested with gjs.
export function parseCpu(stat) {
    // first line of /proc/stat: "cpu  user nice system idle iowait irq softirq steal ..."
    const f = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = f[3] + (f[4] || 0);
    const total = f.reduce((a, b) => a + b, 0);
    return {idle, total};
}

export function cpuPercent(prev, cur) {
    const dt = cur.total - prev.total;
    if (dt <= 0)
        return 0;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - (cur.idle - prev.idle) / dt))));
}

export function memPercent(meminfo) {
    const get = k => Number((meminfo.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [0, 0])[1]);
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    return total ? Math.round(100 * (total - avail) / total) : 0;
}

export function monthGrid(year, month, firstWeekday = 1) {
    // -> array of weeks, each 7 day numbers (0 = blank). firstWeekday 1 = Monday.
    const first = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const lead = (first - firstWeekday + 7) % 7;
    const cells = Array(lead).fill(0).concat(Array.from({length: days}, (_, i) => i + 1));
    while (cells.length % 7)
        cells.push(0);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7)
        weeks.push(cells.slice(i, i + 7));
    return weeks;
}

const WMO = {0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog',
    51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy rain',
    71: 'Snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
    95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm'};
const WMO_ICON = c => c === 0 ? 'weather-clear-symbolic' : c <= 2 ? 'weather-few-clouds-symbolic'
    : c === 3 ? 'weather-overcast-symbolic' : c <= 48 ? 'weather-fog-symbolic'
        : c <= 67 || (c >= 80 && c <= 82) ? 'weather-showers-symbolic' : c <= 77 ? 'weather-snow-symbolic'
            : 'weather-storm-symbolic';

export function parseWeather(json) {
    const d = JSON.parse(json);
    const c = d.current ?? {};
    return {temp: Math.round(c.temperature_2m), code: c.weather_code, text: WMO[c.weather_code] ?? '—',
        icon: WMO_ICON(c.weather_code ?? 0), wind: Math.round(c.wind_speed_10m ?? 0)};
}

export function weatherUrl(lat, lon) {
    const f = v => Number(v).toFixed(2);  // coarse location only
    return `https://api.open-meteo.com/v1/forecast?latitude=${f(lat)}&longitude=${f(lon)}` +
        '&current=temperature_2m,weather_code,wind_speed_10m';
}
