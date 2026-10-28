import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OrbitWidgetsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        const page = new Adw.PreferencesPage();
        const g = new Adw.PreferencesGroup({title: 'Widgets', description: 'Drag a widget on the desktop to move it.'});
        for (const [key, title] of [['show-clock', 'Clock'], ['show-calendar', 'Calendar'], ['show-system', 'System and battery']]) {
            const r = new Adw.SwitchRow({title});
            s.bind(key, r, 'active', Gio.SettingsBindFlags.DEFAULT);
            g.add(r);
        }
        const h24 = new Adw.SwitchRow({title: '24-hour clock'});
        s.bind('clock-24h', h24, 'active', Gio.SettingsBindFlags.DEFAULT);
        g.add(h24);
        page.add(g);
        const w = new Adw.PreferencesGroup({title: 'Weather',
            description: 'Uses the free Open-Meteo service every 30 minutes, with your location rounded to about 1 km. Off by default.'});
        const on = new Adw.SwitchRow({title: 'Show weather'});
        s.bind('show-weather', on, 'active', Gio.SettingsBindFlags.DEFAULT);
        w.add(on);
        const place = new Adw.EntryRow({title: 'Place name'});
        s.bind('weather-place', place, 'text', Gio.SettingsBindFlags.DEFAULT);
        w.add(place);
        for (const [key, title] of [['weather-latitude', 'Latitude'], ['weather-longitude', 'Longitude']]) {
            const r = Adw.SpinRow.new_with_range(-180, 180, 0.01);
            r.set_title(title);
            r.set_digits(2);
            s.bind(key, r, 'value', Gio.SettingsBindFlags.DEFAULT);
            w.add(r);
        }
        const reset = new Adw.ActionRow({title: 'Reset positions', activatable: true});
        reset.connect('activated', () => s.reset('positions'));
        w.add(reset);
        page.add(w);
        window.add(page);
    }
}
