// Orbit Widgets — glass cards on the desktop (above the wallpaper, below windows).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import UPowerGlib from 'gi://UPowerGlib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {cpuPercent, memPercent, monthGrid, parseCpu, parseWeather, weatherUrl} from './sysinfo.js';

// x clears Ubuntu Dock's slim left sidebar (36 px icons + padding)
const DEFAULT_POS = {clock: [88, 64], calendar: [88, 282], system: [88, 530], weather: [370, 64]};

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch {
        return '';
    }
}

const Card = GObject.registerClass(
class Card extends St.BoxLayout {
    _init(ext, id) {
        super._init({vertical: true, reactive: true, track_hover: true, style_class: 'orbit-widget'});
        this._ext = ext;
        this.widgetId = id;
        this.connect('button-press-event', (a, e) => this._press(e));
        this.connect('motion-event', (a, e) => this._motion(e));
        this.connect('button-release-event', () => this._release());
    }

    _press(event) {
        if (event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._drag = {dx: x - this.x, dy: y - this.y};
        this._grab = global.stage.grab(this);
        this.add_style_pseudo_class('dragging');
        return Clutter.EVENT_STOP;
    }

    _motion(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const m = Main.layoutManager.primaryMonitor;
        // keep the card fully on the primary monitor
        this.set_position(
            Math.max(m.x, Math.min(m.x + m.width - this.width, Math.round(x - this._drag.dx))),
            Math.max(m.y, Math.min(m.y + m.height - this.height, Math.round(y - this._drag.dy))));
        return Clutter.EVENT_STOP;
    }

    _release() {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;
        this.remove_style_pseudo_class('dragging');
        this._ext.savePosition(this);
        return Clutter.EVENT_STOP;
    }
});

export default class OrbitWidgets extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cards = new Map();
        this._timers = [];
        this._sigs = [];
        const src = Gio.SettingsSchemaSource.get_default();
        this._orbit = src.lookup('org.orbit-os.desktop', true) ? new Gio.Settings({schema_id: 'org.orbit-os.desktop'}) : null;
        for (const key of ['show-clock', 'show-calendar', 'show-system', 'show-weather', 'clock-24h',
            'weather-latitude', 'weather-longitude', 'weather-place'])
            this._sigs.push([this._settings, this._settings.connect(`changed::${key}`, () => this._rebuild())]);
        if (this._orbit)
            this._sigs.push([this._orbit, this._orbit.connect('changed::reduce-transparency', () => this._applySolid())]);
        this._sigs.push([Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => this._rebuild())]);
        this._rebuild();
    }

    disable() {
        for (const [obj, id] of this._sigs)
            obj.disconnect(id);
        this._sigs = [];
        this._clear();
        this._session?.abort();
        this._session = null;
        this._settings = null;
        this._orbit = null;
    }

    _clear() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = [];
        for (const c of this._cards.values())
            c.destroy();
        this._cards.clear();
    }

    _every(seconds, fn) {
        fn();
        this._timers.push(GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        }));
    }

    _applySolid() {
        const solid = this._orbit?.get_boolean('reduce-transparency') ?? false;
        for (const c of this._cards.values()) {
            if (solid)
                c.add_style_class_name('solid');
            else
                c.remove_style_class_name('solid');
        }
    }

    _place(card) {
        let pos = {};
        try {
            pos = JSON.parse(this._settings.get_string('positions'));
        } catch {}
        const [x, y] = pos[card.widgetId] ?? DEFAULT_POS[card.widgetId];
        const m = Main.layoutManager.primaryMonitor;
        Main.layoutManager._backgroundGroup.add_child(card);
        card.set_position(m.x + x, m.y + y);
        this._cards.set(card.widgetId, card);
    }

    savePosition(card) {
        let pos = {};
        try {
            pos = JSON.parse(this._settings.get_string('positions'));
        } catch {}
        const m = Main.layoutManager.primaryMonitor;
        pos[card.widgetId] = [Math.round(card.x - m.x), Math.round(card.y - m.y)];
        this._settings.set_string('positions', JSON.stringify(pos));
    }

    _rebuild() {
        this._clear();
        if (!Main.layoutManager.primaryMonitor)
            return;
        if (this._settings.get_boolean('show-clock'))
            this._clock();
        if (this._settings.get_boolean('show-calendar'))
            this._calendar();
        if (this._settings.get_boolean('show-system'))
            this._system();
        if (this._settings.get_boolean('show-weather'))
            this._weather();
        this._applySolid();
    }

    _clock() {
        const card = new Card(this, 'clock');
        const time = new St.Label({style_class: 'orbit-widget-big'});
        const date = new St.Label({style_class: 'orbit-widget-sub'});
        card.add_child(time);
        card.add_child(date);
        this._place(card);
        const h24 = this._settings.get_boolean('clock-24h');
        this._every(1, () => {
            const now = GLib.DateTime.new_now_local();
            time.text = now.format(h24 ? '%H:%M' : '%l:%M %p').trim();
            date.text = now.format('%A %e %B').replace(/\s+/g, ' ');
        });
    }

    _calendar() {
        const card = new Card(this, 'calendar');
        const title = new St.Label({style_class: 'orbit-widget-title'});
        const grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_homogeneous: true}),
            style_class: 'orbit-widget-grid'});
        card.add_child(title);
        card.add_child(grid);
        this._place(card);
        let shown = '';
        this._every(60, () => {
            const now = new Date();
            const key = now.toDateString();
            if (key === shown)
                return;
            shown = key;
            title.text = now.toLocaleDateString(undefined, {month: 'long', year: 'numeric'});
            grid.destroy_all_children();
            const lm = grid.layout_manager;
            ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((d, i) =>
                lm.attach(new St.Label({text: d, style_class: 'orbit-widget-dow'}), i, 0, 1, 1));
            monthGrid(now.getFullYear(), now.getMonth()).forEach((week, r) => week.forEach((day, c) => {
                // blanks get a no-break space so short first/last weeks keep their row height
                const l = new St.Label({text: day ? String(day) : '\u00a0',
                    style_class: day === now.getDate() ? 'orbit-widget-day today' : 'orbit-widget-day'});
                lm.attach(l, c, r + 1, 1, 1);
            }));
        });
    }

    _bar(card, label) {
        const row = new St.BoxLayout({vertical: true, style_class: 'orbit-widget-meter'});
        const head = new St.BoxLayout();
        const name = new St.Label({text: label, style_class: 'orbit-widget-sub', x_expand: true});
        const value = new St.Label({style_class: 'orbit-widget-sub'});
        head.add_child(name);
        head.add_child(value);
        const track = new St.Widget({style_class: 'orbit-widget-track', x_expand: true});
        const fill = new St.Widget({style_class: 'orbit-widget-fill'});
        track.add_child(fill);
        row.add_child(head);
        row.add_child(track);
        card.add_child(row);
        return (pct, text) => {
            value.text = text ?? `${pct}%`;
            fill.width = Math.round(track.width * pct / 100);
        };
    }

    _system() {
        const card = new Card(this, 'system');
        card.add_child(new St.Label({text: 'System', style_class: 'orbit-widget-title'}));
        const cpu = this._bar(card, 'Processor');
        const mem = this._bar(card, 'Memory');
        let bat = null;
        let client = null;
        try {
            client = UPowerGlib.Client.new_full(null);
            const dev = client.get_display_device();
            if (dev?.is_present)
                bat = this._bar(card, 'Battery');
        } catch {}
        this._place(card);
        let prev = parseCpu(readFile('/proc/stat'));
        this._every(2, () => {
            const cur = parseCpu(readFile('/proc/stat'));
            cpu(cpuPercent(prev, cur));
            prev = cur;
            mem(memPercent(readFile('/proc/meminfo')));
            if (bat && client) {
                const d = client.get_display_device();
                const charging = d.state === UPowerGlib.DeviceState.CHARGING;
                bat(Math.round(d.percentage), `${Math.round(d.percentage)}%${charging ? ' · charging' : ''}`);
            }
        });
    }

    _weather() {
        const card = new Card(this, 'weather');
        const top = new St.BoxLayout({style_class: 'orbit-widget-row'});
        const icon = new St.Icon({icon_size: 40, icon_name: 'weather-clear-symbolic'});
        const temp = new St.Label({text: '…', style_class: 'orbit-widget-big'});
        top.add_child(icon);
        top.add_child(temp);
        const desc = new St.Label({style_class: 'orbit-widget-sub'});
        card.add_child(new St.Label({text: this._settings.get_string('weather-place'), style_class: 'orbit-widget-title'}));
        card.add_child(top);
        card.add_child(desc);
        this._place(card);
        this._session = this._session ?? new Soup.Session({timeout: 15, user_agent: 'Orbit-OS-Widgets/1'});
        const url = weatherUrl(this._settings.get_double('weather-latitude'), this._settings.get_double('weather-longitude'));
        this._every(1800, () => {
            const msg = Soup.Message.new('GET', url);
            this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    if (msg.get_status() !== Soup.Status.OK)
                        throw new Error(`HTTP ${msg.get_status()}`);
                    const w = parseWeather(new TextDecoder().decode(bytes.get_data()));
                    temp.text = `${w.temp}°`;
                    icon.icon_name = w.icon;
                    desc.text = `${w.text} · wind ${w.wind} km/h`;
                } catch (e) {
                    desc.text = 'Weather unavailable';
                    console.debug(`orbit-widgets: weather: ${e.message}`);
                }
            });
        });
    }
}
