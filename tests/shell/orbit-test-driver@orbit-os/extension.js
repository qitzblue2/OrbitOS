// Test-only: walk through the Orbit desktop in a headless GNOME Shell and save screenshots.
// Output dir comes from $ORBIT_SHOT_DIR. Writes report.json with each extension's state.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('ORBIT_SHOT_DIR') ?? '/tmp/orbit-shots';
const UUIDS = ['orbit-launcher@orbit-os', 'orbit-control-center@orbit-os', 'orbit-widgets@orbit-os',
    'orbit-clipboard@orbit-os', 'ubuntu-dock@ubuntu.com', 'blur-my-shell@aunetx',
    'user-theme@gnome-shell-extensions.gcampax.github.com'];

function shot(name) {
    return new Promise(resolve => {
        const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream, (o, res) => {
            try {
                o.screenshot_finish(res);
            } catch (e) {
                log(`orbit-test-driver: screenshot ${name} failed: ${e}`);
            }
            stream.close(null);
            resolve();
        });
    });
}

const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

function ext(uuid) {
    return Main.extensionManager.lookup(uuid);
}

export default class Driver extends Extension {
    enable() {
        this._run().catch(e => log(`orbit-test-driver: ${e}\n${e.stack}`)).finally(() => {
            const report = {};
            for (const u of UUIDS) {
                const e = ext(u);
                report[u] = e ? {state: e.state, error: e.error ?? ''} : {state: 'missing'};
            }
            report.theme = this._themeInfo ?? null;
            GLib.file_set_contents(`${OUT}/report.json`, JSON.stringify(report, null, 1));
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                global.context.terminate();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    disable() {}

    async _run() {
        GLib.mkdir_with_parents(OUT, 0o755);
        if (Main.layoutManager._startingUp)
            await new Promise(r => Main.layoutManager.connect('startup-complete', r));
        Main.overview.hide();
        await sleep(6000);  // widgets fill in, wallpaper loads
        await shot('desktop');

        // a few copies so the clipboard has history
        const cb = St.Clipboard.get_default();
        for (const t of ['Meeting moved to 15:00', 'https://github.com/qitzblue2/OrbitOS', 'sudo apt update && sudo apt upgrade',
            'Orbit OS — based on Ubuntu 24.04 LTS']) {
            cb.set_text(St.ClipboardType.CLIPBOARD, t);
            await sleep(400);
        }

        const qs = Main.panel.statusArea.quickSettings;
        qs.menu.open();
        await sleep(1500);
        await shot('quick-settings');
        // record what the theme really resolved to, for debugging theme regressions
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const findChecked = actor => {
            if (actor.has_style_class_name?.('quick-toggle') && actor.checked)
                return actor;
            for (const c of actor.get_children?.() ?? []) {
                const f = findChecked(c);
                if (f)
                    return f;
            }
            return null;
        };
        const t = findChecked(qs.menu.actor ?? qs.menu.box);
        const bg = t?.get_theme_node().get_background_color();
        this._themeInfo = {
            application_stylesheet: theme.application_stylesheet?.get_path() ?? null,
            theme_stylesheet: theme.theme_stylesheet?.get_path() ?? null,
            custom: theme.get_custom_stylesheets().map(f => f.get_path()),
            checked_toggle_bg: bg ? [bg.red, bg.green, bg.blue, bg.alpha] : null,
            checked_toggle_classes: t ? [t.get_style_class_name(), t.get_style_pseudo_class(), t.constructor.name] : null,
            menu_bg: (() => {
                const n = (qs.menu.box ?? qs.menu.actor).get_theme_node().get_background_color();
                return [n.red, n.green, n.blue, n.alpha];
            })(),
            menu_classes: (qs.menu.box ?? qs.menu.actor).get_style_class_name(),


        };
        qs.menu.close();
        await sleep(500);

        const launcher = ext('orbit-launcher@orbit-os')?.stateObj;
        if (launcher) {
            launcher._toggle();
            await sleep(800);
            launcher._dialog?._entry.set_text('12*7');
            await sleep(800);
            await shot('launcher-calc');
            launcher._dialog?._entry.set_text('term');
            await sleep(800);
            await shot('launcher-search');
            launcher._toggle();
            await sleep(500);
        }

        const clip = ext('orbit-clipboard@orbit-os')?.stateObj;
        if (clip) {
            clip.toggle();
            await sleep(1000);
            await shot('clipboard');
            clip.toggle();
            await sleep(500);
        }

        Main.overview.showApps();
        await sleep(2500);
        await shot('app-grid');
        Main.overview.hide();
        await sleep(1000);
    }
}
