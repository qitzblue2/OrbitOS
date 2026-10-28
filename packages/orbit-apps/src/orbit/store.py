"""Orbit Store — a small, curated app shop over Ubuntu's archive and Flathub.

Only vetted apps are listed (data/store-catalog.json). Ubuntu packages are
installed through a polkit-protected helper that refuses anything outside the
catalog; Flathub apps are installed per-user and need no password.
"""
import subprocess
import threading

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, GObject, Gtk, Pango  # noqa: E402

from . import catalog, ui  # noqa: E402

CATEGORY_ICONS = {"Featured": "starred-symbolic", "All": "view-app-grid-symbolic", "Installed": "emblem-ok-symbolic",
                  "Internet": "network-wireless-symbolic", "Office": "x-office-document-symbolic",
                  "Graphics": "applications-graphics-symbolic", "Media": "applications-multimedia-symbolic",
                  "Development": "utilities-terminal-symbolic", "Games": "applications-games-symbolic",
                  "Windows apps": "computer-symbolic", "Utilities": "applications-utilities-symbolic"}


def app_icon(a, size):
    img = Gtk.Image(pixel_size=size)
    theme = Gtk.IconTheme.get_for_display(img.get_display()) if img.get_display() else None
    name = a.get("icon", "")
    if theme and name and theme.has_icon(name):
        img.set_from_icon_name(name)
    else:
        img.set_from_icon_name(CATEGORY_ICONS.get(a["category"], "application-x-executable-symbolic"))
        img.add_css_class("dim-label")
    return img


class Job(GObject.Object):
    """Runs one install/remove command, streaming its output."""
    __gsignals__ = {"line": (GObject.SignalFlags.RUN_LAST, None, (str,)),
                    "done": (GObject.SignalFlags.RUN_LAST, None, (int,))}

    def __init__(self, app, action, argv):
        super().__init__()
        self.app, self.action, self.argv = app, action, argv

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            p = subprocess.Popen(self.argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        except OSError as e:
            GLib.idle_add(self.emit, "line", str(e))
            GLib.idle_add(self.emit, "done", 127)
            return
        for raw in iter(p.stdout.readline, ""):
            for part in raw.replace("\r", "\n").split("\n"):
                if part.strip():
                    GLib.idle_add(self.emit, "line", part.strip())
        p.stdout.close()
        GLib.idle_add(self.emit, "done", p.wait())


class AppCard(Gtk.Button):
    def __init__(self, win, a):
        super().__init__(css_classes=["orbit-card", "flat"], width_request=300)
        self.a = a
        box = Gtk.Box(spacing=14)
        box.append(app_icon(a, 56))
        text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, valign=Gtk.Align.CENTER, hexpand=True)
        text.append(Gtk.Label(label=a["name"], xalign=0, css_classes=["heading"], ellipsize=Pango.EllipsizeMode.END))
        text.append(Gtk.Label(label=a["summary"], xalign=0, css_classes=["dim-label", "caption"], wrap=True, lines=2,
                              ellipsize=Pango.EllipsizeMode.END, max_width_chars=28))
        badges = Gtk.Box(spacing=6, margin_top=4)
        badges.append(Gtk.Label(label="Ubuntu" if a["source"] == "apt" else "Flathub", css_classes=["orbit-pill"]))
        self.state = Gtk.Label(css_classes=["orbit-pill", "orbit-lit"], visible=False, label="Installed")
        badges.append(self.state)
        text.append(badges)
        box.append(text)
        self.set_child(box)
        self.connect("clicked", lambda *_: win.show_details(a))

    def set_installed(self, on):
        self.state.set_visible(bool(on))


class StoreWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Orbit Store", default_width=1180, default_height=780)
        self._toasts = Adw.ToastOverlay()
        self.apps, cats = catalog.load()
        self.installed = {}
        self.flathub = True
        self.jobs = {}
        self.category = "Featured"
        self.cards = []

        # sidebar
        self.side = Gtk.ListBox(css_classes=["navigation-sidebar"])
        for c in ["Featured", "All", "Installed"] + [c for c in cats if c != "Featured"]:
            row = Gtk.ListBoxRow()
            b = Gtk.Box(spacing=10, margin_start=6, margin_top=3, margin_bottom=3)
            b.append(Gtk.Image(icon_name=CATEGORY_ICONS.get(c, "folder-symbolic")))
            b.append(Gtk.Label(label=c, xalign=0))
            row.set_child(b)
            row._cat = c
            self.side.append(row)
        self.side.connect("row-selected", lambda lb, r: r and self.set_category(r._cat))
        side_tv = Adw.ToolbarView()
        sh = Adw.HeaderBar(show_title=False)
        sh.pack_start(Gtk.Label(label="Store", css_classes=["heading"], margin_start=6))
        side_tv.add_top_bar(sh)
        side_tv.set_content(Gtk.ScrolledWindow(child=self.side))

        # browse page
        self.search = Gtk.SearchEntry(placeholder_text="Search apps", hexpand=True)
        self.search.connect("search-changed", lambda *_: self.refilter())
        self.flow = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, homogeneous=True, column_spacing=14,
                                row_spacing=14, max_children_per_line=4, valign=Gtk.Align.START)
        for a in self.apps:
            c = AppCard(self, a)
            self.cards.append(c)
            self.flow.append(c)
        self.flow.set_filter_func(self._filter)
        self.heading = Gtk.Label(xalign=0, css_classes=["orbit-title"])
        self.subheading = Gtk.Label(xalign=0, css_classes=["dim-label"], wrap=True)
        self.banner = Adw.Banner(title="Flathub is off: apps marked Flathub can’t be installed yet",
                                 button_label="Enable Flathub")
        self.banner.connect("button-clicked", lambda *_: self.enable_flathub())
        self.none = Adw.StatusPage(icon_name="system-search-symbolic", title="No apps found",
                                   description="Try another word, or look in All.", visible=False)
        browse = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin_top=18, margin_bottom=24,
                         margin_start=24, margin_end=24)
        browse.append(self.heading)
        browse.append(self.subheading)
        browse.append(Gtk.Box(height_request=10))
        browse.append(self.flow)
        browse.append(self.none)
        bhb = Adw.HeaderBar(title_widget=Adw.Clamp(child=self.search, maximum_size=460))
        menu = Gio.Menu()
        menu.append("Check for Updates", "win.updates")
        menu.append("About Orbit Store", "win.about")
        bhb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))
        btv = Adw.ToolbarView()
        btv.add_top_bar(bhb)
        btv.add_top_bar(self.banner)
        btv.set_content(Gtk.ScrolledWindow(child=browse))
        self.nav = Adw.NavigationView()
        self.nav.add(Adw.NavigationPage(child=btv, title="Browse", tag="browse"))

        self.split = Adw.NavigationSplitView(sidebar=Adw.NavigationPage(child=side_tv, title="Store"),
                                             content=Adw.NavigationPage(child=self.nav, title="Apps"),
                                             min_sidebar_width=200, max_sidebar_width=240)
        bp = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 700sp"))
        bp.add_setter(self.split, "collapsed", True)
        self.add_breakpoint(bp)
        self._toasts.set_child(self.split)
        self.set_content(self._toasts)
        for name, cb in {"updates": lambda: ui.spawn(["gnome-software", "--mode=updates"]),
                         "about": lambda: ui.about(self, "Orbit Store", "orbit-store",
                                                   "Hand-picked apps from Ubuntu and Flathub.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self.side.select_row(self.side.get_row_at_index(0))
        self.refresh_state()

    # ---- state
    def refresh_state(self):
        def work():
            return catalog.installed_map(self.apps), catalog.flathub_enabled()

        def done(res):
            self.installed, flathub = res
            self.flathub = flathub
            for c in self.cards:
                c.set_installed(self.installed.get(c.a["name"]))
            self.banner.set_revealed(not flathub)
            self.refilter()
        ui.run_async(work, done)

    def set_category(self, c):
        self.category = c
        self.nav.pop_to_tag("browse")
        self.split.set_show_content(True)
        self.refilter()

    def _filter(self, child):
        a = child.get_child().a
        q = self.search.get_text().strip()
        if q:
            return bool(catalog.search([a], q))
        if self.category == "Featured":
            return a.get("featured", False)
        if self.category == "Installed":
            return bool(self.installed.get(a["name"]))
        return self.category == "All" or a["category"] == self.category

    def refilter(self):
        self.flow.invalidate_filter()
        q = self.search.get_text().strip()
        titles = {"Featured": ("Featured", "Good places to start."), "All": ("All apps", ""),
                  "Installed": ("Installed", "Apps from this catalog that are on your computer.")}
        h, sub = titles.get(self.category, (self.category, ""))
        self.heading.set_label(f"Results for “{q}”" if q else h)
        self.subheading.set_label("" if q else sub)
        self.subheading.set_visible(bool(sub) and not q)
        shown = sum(1 for c in self.cards if self._filter(c.get_parent()))
        self.none.set_visible(shown == 0)
        self.flow.set_visible(shown > 0)

    # ---- details
    def show_details(self, a):
        page = Adw.PreferencesPage()
        head = Gtk.Box(spacing=20, margin_bottom=12)
        head.append(app_icon(a, 96))
        tb = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, valign=Gtk.Align.CENTER, hexpand=True)
        tb.append(Gtk.Label(label=a["name"], xalign=0, css_classes=["title-1"]))
        tb.append(Gtk.Label(label=a["summary"], xalign=0, css_classes=["dim-label"], wrap=True))
        head.append(tb)
        btns = Gtk.Box(spacing=8, valign=Gtk.Align.CENTER)
        head.append(btns)
        g0 = Adw.PreferencesGroup()
        g0.add(head)
        page.add(g0)
        progress = Gtk.ProgressBar(visible=False, show_text=True)
        log = Gtk.Label(xalign=0, wrap=True, css_classes=["caption", "orbit-mono", "dim-label"], selectable=True)
        exp = Gtk.Expander(label="Details", child=log, visible=False)
        g1 = Adw.PreferencesGroup()
        g1.add(progress)
        g1.add(exp)
        page.add(g1)
        g2 = Adw.PreferencesGroup(title="About")
        g2.add(Gtk.Label(label=a.get("description", ""), xalign=0, wrap=True))
        page.add(g2)
        g3 = Adw.PreferencesGroup(title="Details")
        src = "Ubuntu archive (signed by Ubuntu)" if a["source"] == "apt" else "Flathub (sandboxed, per user)"
        for k, v in (("Source", src), ("Category", a["category"]),
                     ("Package" if a["source"] == "apt" else "App ID",
                      " ".join(a["packages"]) if a["source"] == "apt" else a["id"]),
                     ("Password needed", "Yes, once (installs for everyone)" if a["source"] == "apt"
                      else "No")):
            r = Adw.ActionRow(title=k, subtitle=v, subtitle_selectable=True)
            r.add_css_class("property")
            g3.add(r)
        if "proprietary" in a["summary"].lower():
            note = Adw.ActionRow(title="Proprietary software",
                                 subtitle="Not open source. Made and supported by its own company.")
            note.add_prefix(Gtk.Image(icon_name="dialog-information-symbolic"))
            g3.add(note)
        page.add(g3)

        def rebuild_buttons():
            while (c := btns.get_first_child()) is not None:
                btns.remove(c)
            busy = a["name"] in self.jobs
            inst = self.installed.get(a["name"])
            if busy:
                sp = Gtk.Spinner(spinning=True)
                btns.append(sp)
                return
            if inst:
                o = Gtk.Button(label="Open", css_classes=["suggested-action", "pill"])
                o.connect("clicked", lambda *_: ui.spawn(catalog.launch_command(a)))
                rm = Gtk.Button(label="Remove", css_classes=["destructive-action", "pill"])
                rm.connect("clicked", lambda *_: ui.confirm(self, f"Remove {a['name']}?",
                                                            "Your own files made with it are kept.", "Remove",
                                                            lambda: start("remove")))
                btns.append(o)
                btns.append(rm)
            elif a["source"] == "flathub" and not self.flathub:
                i = Gtk.Button(label="Enable Flathub First", css_classes=["pill"])
                i.connect("clicked", lambda *_: self.enable_flathub(rebuild_buttons))
                btns.append(i)
            else:
                i = Gtk.Button(label="Install", css_classes=["suggested-action", "pill"])
                i.connect("clicked", lambda *_: start("install"))
                btns.append(i)

        def start(action):
            job = Job(a, action, catalog.action_command(a, action))
            self.jobs[a["name"]] = job
            progress.set_visible(True)
            progress.set_fraction(0)
            progress.set_text("Installing…" if action == "install" else "Removing…")
            exp.set_visible(True)
            lines = []

            def on_line(j, text):
                lines.append(text)
                log.set_label("\n".join(lines[-40:]))
                import re
                m = re.search(r"(\d{1,3})%", text)
                if m:
                    progress.set_fraction(min(1, int(m.group(1)) / 100))
                else:
                    progress.pulse()
                progress.set_text(text[:70])

            def on_done(j, rc):
                del self.jobs[a["name"]]
                if rc == 0:
                    progress.set_fraction(1)
                    progress.set_text("Done")
                    ui.toast(self, f"{a['name']} {'installed' if action == 'install' else 'removed'}")
                else:
                    progress.set_text("Cancelled" if rc in (126, 127) else f"Failed (code {rc})")
                    ui.toast(self, f"Could not {action} {a['name']}: see Details")
                self.refresh_state()
                GLib.timeout_add(1200, lambda: (rebuild_buttons(), False)[1])
            job.connect("line", on_line)
            job.connect("done", on_done)
            job.start()
            rebuild_buttons()

        rebuild_buttons()
        tv = Adw.ToolbarView()
        tv.add_top_bar(Adw.HeaderBar())
        tv.set_content(page)
        self.nav.push(Adw.NavigationPage(child=tv, title=a["name"]))

    def enable_flathub(self, then=None):
        def done(rc):
            ui.toast(self, "Flathub enabled" if rc == 0 else "Could not enable Flathub (are you online?)")
            self.flathub = rc == 0
            self.refresh_state()
            if then:
                then()
        ui.run_async(lambda: subprocess.run(catalog.ENABLE_FLATHUB, check=False).returncode, done)


class StoreApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Store", lambda app: StoreWindow(app))
        self.connect("startup", lambda *_: ui.add_shortcuts(self, {"win.updates": ["<Ctrl>u"]}))


def main():
    return StoreApp().run_main()
