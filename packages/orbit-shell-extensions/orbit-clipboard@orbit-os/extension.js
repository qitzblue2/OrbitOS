// Orbit Clipboard — Super+V history with search and pins.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {History, looksSecret, preview} from './history.js';

const STORE = GLib.build_filenamev([GLib.get_user_data_dir(), 'orbit', 'clipboard.json']);

const HistoryDialog = GObject.registerClass(
class HistoryDialog extends ModalDialog.ModalDialog {
    _init(ext) {
        super._init({styleClass: 'orbit-clipboard-dialog', destroyOnClose: true});
        this._ext = ext;
        this._entry = new St.Entry({hint_text: 'Search clipboard history', can_focus: true,
            style_class: 'orbit-clipboard-entry'});
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'orbit-clipboard-list'});
        const scroll = new St.ScrollView({style_class: 'orbit-clipboard-scroll', hscrollbar_policy: St.PolicyType.NEVER});
        scroll.set_child(this._list);
        this.contentLayout.add_child(this._entry);
        this.contentLayout.add_child(scroll);
        this.addButton({label: 'Clear unpinned', action: () => {
            ext.history.clear(true);
            ext.persist();
            this._fill();
        }});
        this.addButton({label: 'Close', action: () => this.close(), key: Clutter.KEY_Escape});
        this._entry.clutter_text.connect('text-changed', () => this._fill());
        this._entry.clutter_text.connect('activate', () => this._first?.());
        this._fill();
    }

    open() {
        const ok = super.open();
        this._entry.grab_key_focus();
        return ok;
    }

    _fill() {
        this._list.destroy_all_children();
        this._first = null;
        const items = this._ext.history.search(this._entry.get_text());
        if (!items.length) {
            this._list.add_child(new St.Label({text: this._ext.history.items.length ? 'No matches' : 'Nothing copied yet',
                style_class: 'orbit-clipboard-empty'}));
            return;
        }
        for (const it of items.slice(0, 60)) {
            const row = new St.BoxLayout({style_class: 'orbit-clipboard-row'});
            const btn = new St.Button({style_class: 'orbit-clipboard-item', x_expand: true, can_focus: true,
                label: preview(it.text)});
            btn.get_child().x_align = Clutter.ActorAlign.START;
            const choose = () => {
                this.close();
                this._ext.use(it.text);
            };
            btn.connect('clicked', choose);
            this._first ??= choose;
            const pin = new St.Button({style_class: 'orbit-clipboard-pin', can_focus: true,
                child: new St.Icon({icon_name: it.pinned ? 'view-pin-symbolic' : 'view-pin-symbolic',
                    style_class: it.pinned ? 'pinned' : '', icon_size: 16}),
                accessible_name: it.pinned ? 'Unpin' : 'Pin'});
            pin.connect('clicked', () => {
                this._ext.history.togglePin(it.text);
                this._ext.persist();
                this._fill();
            });
            const del = new St.Button({style_class: 'orbit-clipboard-pin', can_focus: true,
                child: new St.Icon({icon_name: 'edit-delete-symbolic', icon_size: 16}), accessible_name: 'Forget'});
            del.connect('clicked', () => {
                this._ext.history.remove(it.text);
                this._ext.persist();
                this._fill();
            });
            row.add_child(btn);
            row.add_child(pin);
            row.add_child(del);
            this._list.add_child(row);
        }
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Clipboard');
        this._ext = ext;
        this.add_child(new St.Icon({icon_name: 'orbit-clipboard-symbolic', style_class: 'system-status-icon'}));
        this.menu.connect('open-state-changed', (m, open) => open && this._fill());
    }

    _fill() {
        this.menu.removeAll();
        const items = this._ext.history.search('').slice(0, 10);
        if (!items.length)
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Nothing copied yet', {reactive: false}));
        for (const it of items) {
            const mi = new PopupMenu.PopupMenuItem(preview(it.text, 50));
            if (it.pinned)
                mi.setOrnament(PopupMenu.Ornament.DOT);
            mi.connect('activate', () => this._ext.use(it.text, false));
            this.menu.addMenuItem(mi);
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const paused = this._ext.settings.get_boolean('paused');
        const p = new PopupMenu.PopupSwitchMenuItem('Record clipboard', !paused);
        p.connect('toggled', (_i, on) => this._ext.settings.set_boolean('paused', !on));
        this.menu.addMenuItem(p);
        const all = new PopupMenu.PopupMenuItem('Show all… (Super+V)');
        all.connect('activate', () => this._ext.toggle());
        this.menu.addMenuItem(all);
    }
});

export default class OrbitClipboard extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.history = new History(this.settings.get_int('history-size'));
        try {
            const [ok, bytes] = GLib.file_get_contents(STORE);
            if (ok)
                this.history.load(new TextDecoder().decode(bytes));
        } catch {}
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (sel, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onCopy();
        });
        this._sizeId = this.settings.connect('changed::history-size', () => {
            this.history.limit = this.settings.get_int('history-size');
            this.history._trim();
        });
        Main.wm.addKeybinding('toggle-history', this.settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea('orbit-clipboard', this._indicator, 1, 'right');
    }

    disable() {
        Main.wm.removeKeybinding('toggle-history');
        this._selection?.disconnect(this._ownerId);
        this.settings?.disconnect(this._sizeId);
        this.persist();
        this._dialog?.close();
        this._dialog = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._virtual = null;
        this.history = null;
        this.settings = null;
    }

    _onCopy() {
        if (this.settings.get_boolean('paused') || Main.sessionMode.isLocked || this._ignoreNext) {
            this._ignoreNext = false;
            return;
        }
        // Password managers mark their copies; never record those.
        const types = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
        if (looksSecret(types))
            return;
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (text && this.history?.add(text))
                this.persist();
        });
    }

    persist() {
        if (!this.history || !this.settings)
            return;
        const all = this.settings.get_boolean('remember-across-sessions');
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(STORE), 0o700);
            const f = Gio.File.new_for_path(STORE);
            f.replace_contents(new TextEncoder().encode(this.history.serialize(all)), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`orbit-clipboard: cannot save: ${e.message}`);
        }
    }

    toggle() {
        if (this._dialog) {
            this._dialog.close();
            return;
        }
        this._dialog = new HistoryDialog(this);
        this._dialog.connect('destroy', () => (this._dialog = null));
        this._dialog.open();
    }

    use(text, paste = true) {
        this._ignoreNext = false;
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this.history.add(text);
        if (paste && this.settings.get_boolean('paste-on-select')) {
            // give focus back to the app, then press Ctrl+V for the user
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._virtual ??= seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                const t = GLib.get_monotonic_time();
                this._virtual.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
                this._virtual.notify_keyval(t + 10, Clutter.KEY_v, Clutter.KeyState.PRESSED);
                this._virtual.notify_keyval(t + 20, Clutter.KEY_v, Clutter.KeyState.RELEASED);
                this._virtual.notify_keyval(t + 30, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
                return GLib.SOURCE_REMOVE;
            });
        }
    }
}
