// Orbit Launcher — GNOME Shell 46 extension (ESM).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {evaluate} from './calc.js';

const MAX_RESULTS = 8;
const MAX_FILES = 400;

function listFiles(root) {
    // Shallow, bounded walk (depth 3) so typing never blocks the shell for long.
    const out = [];
    const walk = (dir, depth) => {
        if (depth > 3 || out.length >= MAX_FILES)
            return;
        let en;
        try {
            en = dir.enumerate_children('standard::name,standard::type,standard::is-hidden',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return;
        }
        let info;
        while ((info = en.next_file(null)) && out.length < MAX_FILES) {
            if (info.get_is_hidden())
                continue;
            const child = dir.get_child(info.get_name());
            out.push(child);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                walk(child, depth + 1);
        }
        en.close(null);
    };
    walk(root, 0);
    return out;
}

// ModalDialog is a GObject class: subclasses must be registered and use _init (found by
// tests/shell/run-desktop-shots.sh; a plain ES class throws "construct an object without a GType").
const LauncherDialog = GObject.registerClass(
class LauncherDialog extends ModalDialog.ModalDialog {
    _init(settings) {
        super._init({styleClass: 'orbit-launcher', destroyOnClose: true});
        this._settings = settings;
        this._appSystem = Shell.AppSystem.get_default();

        this._entry = new St.Entry({style_class: 'orbit-launcher-entry', hint_text: 'Search apps, files, settings, or type 2+2', can_focus: true});
        this._results = new St.BoxLayout({vertical: true, style_class: 'orbit-launcher-results', x_expand: true});
        this._folders = new St.BoxLayout({style_class: 'orbit-launcher-folders'});
        this.contentLayout.add_child(this._entry);
        this.contentLayout.add_child(this._folders);
        this.contentLayout.add_child(this._results);

        this._entry.clutter_text.connect('text-changed', () => this._update());
        this._entry.clutter_text.connect('activate', () => this._activateFirst());
        this._buildFolders();
        this._update();
    }

    open() {
        const ok = super.open();
        this._entry.grab_key_focus();
        return ok;
    }

    _buildFolders() {
        let folders = [];
        try {
            folders = JSON.parse(this._settings.get_string('folders'));
        } catch {
            logError(new Error('orbit-launcher: invalid folders JSON'));
        }
        for (const f of folders) {
            const btn = new St.Button({label: f.name, style_class: 'orbit-launcher-folder', can_focus: true,
                style: `border-left: 3px solid ${/^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#888888'};`});
            btn.connect('clicked', () => this._showApps(f.apps.map(id => this._appSystem.lookup_app(id)).filter(Boolean)));
            this._folders.add_child(btn);
        }
    }

    _row(label, sub, icon, action) {
        // St.Button centres its child by default: fill the row and left-align, like a list
        const btn = new St.Button({style_class: 'orbit-launcher-row', can_focus: true, x_expand: true,
            x_align: Clutter.ActorAlign.FILL});
        const box = new St.BoxLayout({style_class: 'orbit-launcher-row-box', x_expand: true,
            x_align: Clutter.ActorAlign.START});
        if (icon)
            box.add_child(new St.Icon({gicon: icon, icon_size: 24}));
        const text = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(new St.Label({text: label, style_class: 'orbit-launcher-title'}));
        if (sub)
            text.add_child(new St.Label({text: sub, style_class: 'orbit-launcher-sub'}));
        box.add_child(text);
        btn.set_child(box);
        btn._orbitAction = action;
        btn.connect('clicked', () => {
            this.close();
            action();
        });
        this._results.add_child(btn);
    }

    _showApps(apps) {
        this._results.destroy_all_children();
        for (const app of apps.slice(0, MAX_RESULTS))
            this._row(app.get_name(), app.get_description(), app.get_icon(), () => app.activate());
    }

    _update() {
        const q = this._entry.get_text().trim();
        this._results.destroy_all_children();
        if (!q)
            return;

        const v = evaluate(q);
        if (v !== null) {
            this._row(`= ${v}`, 'Press Enter to copy', Gio.ThemedIcon.new('org.gnome.Calculator'), () =>
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, String(v)));
        }

        // Apps and Settings panels (Settings panels are desktop files too).
        const ids = Shell.AppSystem.search(q).flat();
        const apps = ids.map(id => this._appSystem.lookup_app(id)).filter(Boolean);
        for (const app of apps.slice(0, MAX_RESULTS)) {
            const isPanel = app.get_id().startsWith('gnome-') && app.get_id().endsWith('-panel.desktop');
            this._row(app.get_name(), isPanel ? 'Settings' : app.get_description(), app.get_icon(), () => app.activate());
        }

        if (q.length >= 2) {
            const root = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_home_dir(), this._settings.get_string('file-search-root')]));
            const lq = q.toLowerCase();
            let n = 0;
            for (const f of listFiles(root)) {
                if (n >= 5)
                    break;
                if (!f.get_basename().toLowerCase().includes(lq))
                    continue;
                n++;
                this._row(f.get_basename(), f.get_parent()?.get_path() ?? '', Gio.ThemedIcon.new('folder'),
                    () => Gio.AppInfo.launch_default_for_uri(f.get_uri(), null));
            }
        }
    }

    _activateFirst() {
        const first = this._results.get_first_child();
        if (first?._orbitAction) {
            this.close();
            first._orbitAction();
        }
    }
});

export default class OrbitLauncherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        Main.wm.addKeybinding('toggle-launcher', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggle());
        // Super (overlay-key) and the Activities button call Main.overview.toggle().
        // Optionally route that to the launcher; Super+A (app grid) and the dock keep the overview.
        this._origToggle = Main.overview.toggle;
        Main.overview.toggle = () => {
            if (this._settings.get_boolean('replace-overview-key') && !Main.overview.visible)
                this._toggle();
            else
                this._origToggle.call(Main.overview);
        };
    }

    _toggle() {
        if (this._dialog) {
            this._dialog.close();
            this._dialog = null;
            return;
        }
        this._dialog = new LauncherDialog(this._settings);
        this._dialog.connect('destroy', () => (this._dialog = null));
        this._dialog.open();
    }

    disable() {
        Main.wm.removeKeybinding('toggle-launcher');
        if (this._origToggle)
            Main.overview.toggle = this._origToggle;
        this._origToggle = null;
        this._dialog?.close();
        this._dialog = null;
        this._settings = null;
    }
}
