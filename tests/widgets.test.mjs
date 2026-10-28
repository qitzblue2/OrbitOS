import {cpuPercent, memPercent, monthGrid, parseCpu, parseWeather, weatherUrl} from '../packages/orbit-shell-extensions/orbit-widgets@orbit-os/sysinfo.js';
let bad = 0; const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { bad++; console.log('FAIL', m, a, b); } };
const a = parseCpu('cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 ...'), b = parseCpu('cpu  150 0 150 900 0 0 0 0 0 0');
eq(cpuPercent(a, b), 50, 'cpu');
eq(memPercent('MemTotal:       1000 kB\nMemFree: 1 kB\nMemAvailable:    250 kB\n'), 75, 'mem');
const oct = monthGrid(2026, 9);  // October 2026 starts on a Thursday
eq(oct[0], [0, 0, 0, 1, 2, 3, 4], 'grid first week');
eq(oct.flat().filter(Boolean).length, 31, 'grid days');
eq(parseWeather('{"current":{"temperature_2m":12.6,"weather_code":3,"wind_speed_10m":14.2}}'), {temp: 13, code: 3, text: 'Cloudy', icon: 'weather-overcast-symbolic', wind: 14}, 'weather');
eq(weatherUrl(52.371234, 4.899876).includes('latitude=52.37&longitude=4.90'), true, 'coarse location');
console.log(bad ? 'sysinfo tests failed' : 'sysinfo tests passed'); process.exit(bad ? 1 : 0);
