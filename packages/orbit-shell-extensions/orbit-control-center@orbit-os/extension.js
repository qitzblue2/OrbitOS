// Orbit Control Center — adds Orbit toggles to GNOME's Quick Settings menu.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const STYLES = [['glass', 'Glass'], ['graphite', 'Graphite'], ['light', 'Light']];

function orbitSettings() {
    const src = Gio.SettingsSchemaSource.get_default();
    return src.lookup('org.orbit-os.desktop', true) ? new Gio.Settings({schema_id: 'org.orbit-os.desktop'}) : null;
}

function spawn(argv) {
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    } catch (e) {
        Main.notifyError('Orbit Control Center', `${argv[0]}: ${e.message}`);
    }
}

function spacesFile() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'orbit', 'spaces.json']);
}

function readSpaces() {
    const fallback = {spaces: [{name: 'Personal'}, {name: 'Work'}, {name: 'Study'}], current: null};
    try {
        const [ok, bytes] = GLib.file_get_contents(spacesFile());
        if (!ok)
            return fallback;
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return Array.isArray(data.spaces) && data.spaces.length ? data : fallback;
    } catch {
        return fallback;
    }
}

const GlassToggle = GObject.registerClass(
class GlassToggle extends QuickToggle {
    _init(settings) {
        super._init({title: 'Glass', subtitle: 'Frosted surfaces', iconName: 'orbit-widgets-symbolic', toggleMode: true});
        this._settings = settings;
        this._sync();
        this._id = settings.connect('changed::reduce-transparency', () => this._sync());
        this.connect('clicked', () => {
            spawn(['/usr/lib/orbit-os/orbit-transparency', this.checked ? 'off' : 'on']);
        });
    }

    _sync() {
        this.checked = !this._settings.get_boolean('reduce-transparency');
        this.subtitle = this.checked ? 'Frosted surfaces' : 'Solid (faster)';
    }

    destroy() {
        this._settings.disconnect(this._id);
        super.destroy();
    }
});

const StyleToggle = GObject.registerClass(
class StyleToggle extends QuickMenuToggle {
    _init(settings) {
        super._init({title: 'Style', iconName: 'orbit-control-center-symbolic', toggleMode: false});
        this._settings = settings;
        this.menu.setHeader('orbit-control-center-symbolic', 'Orbit style', 'Icons, shell and wallpaper together');
        this._items = new Map();
        for (const [id, label] of STYLES) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => spawn(['orbit-style', id]));
            this.menu.addMenuItem(item);
            this._items.set(id, item);
        }
        this._id = settings.connect('changed::style', () => this._sync());
        this.connect('clicked', () => this.menu.open());
        this._sync();
    }

    _sync() {
        const cur = this._settings.get_string('style');
        this.subtitle = STYLES.find(s => s[0] === cur)?.[1] ?? cur;
        this.checked = true;
        for (const [id, item] of this._items)
            item.setOrnament(id === cur ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    destroy() {
        this._settings.disconnect(this._id);
        super.destroy();
    }
});

const SpaceToggle = GObject.registerClass(
class SpaceToggle extends QuickMenuToggle {
    _init() {
        super._init({title: 'Space', iconName: 'orbit-spaces-symbolic', toggleMode: false});
        this.menu.setHeader('orbit-spaces-symbolic', 'Spaces', 'Folder, wallpaper, dock and notifications');
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const edit = new PopupMenu.PopupMenuItem('Edit Spaces…');
        edit.connect('activate', () => spawn(['orbit-spaces']));
        this.menu.addMenuItem(edit);
        this.connect('clicked', () => this.menu.open());
        const dir = Gio.File.new_for_path(GLib.path_get_dirname(spacesFile()));
        try {
            GLib.mkdir_with_parents(dir.get_path(), 0o755);
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._sync());
        } catch (e) {
            console.warn(`orbit-control-center: cannot watch spaces: ${e.message}`);
        }
        this._sync();
    }

    _sync() {
        const data = readSpaces();
        this._section.removeAll();
        for (const s of data.spaces) {
            const item = new PopupMenu.PopupMenuItem(String(s.name));
            item.setOrnament(s.name === data.current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connect('activate', () => spawn(['orbit-spaces', 'switch', String(s.name)]));
            this._section.addMenuItem(item);
        }
        this.subtitle = data.current ?? 'None';
        this.checked = data.current !== null;
    }

    destroy() {
        this._monitor?.cancel();
        super.destroy();
    }
});

const InboxToggle = GObject.registerClass(
class InboxToggle extends QuickToggle {
    _init(settings) {
        super._init({title: 'Sort Inbox', subtitle: 'Move files by type', iconName: 'folder-inbox-symbolic',
            toggleMode: true});
        this._settings = settings;
        settings.bind('inbox-sorter', this, 'checked', Gio.SettingsBindFlags.DEFAULT);
        this._id = settings.connect('changed::inbox-sorter', () => {
            const on = settings.get_boolean('inbox-sorter');
            spawn(['systemctl', '--user', on ? 'enable' : 'disable', '--now', 'orbit-inbox-sorter.timer']);
        });
    }

    destroy() {
        this._settings.disconnect(this._id);
        super.destroy();
    }
});

const OrbitIndicator = GObject.registerClass(
class OrbitIndicator extends SystemIndicator {
    _init(settings) {
        super._init();
        if (settings) {
            this.quickSettingsItems.push(new GlassToggle(settings));
            this.quickSettingsItems.push(new StyleToggle(settings));
            this.quickSettingsItems.push(new InboxToggle(settings));
        }
        this.quickSettingsItems.push(new SpaceToggle());
    }

    destroy() {
        this.quickSettingsItems.forEach(i => i.destroy());
        super.destroy();
    }
});

export default class OrbitControlCenter extends Extension {
    enable() {
        this._indicator = new OrbitIndicator(orbitSettings());
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
