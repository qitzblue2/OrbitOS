"""Orbit Spaces — make, edit and switch Spaces.

A Space = a folder in ~/Home/Spaces + a color + a wallpaper + the dock apps +
whether notifications pop up. Switching applies all of it at once.

CLI (used by the Control Center and keyboard shortcuts):
  orbit-spaces list | current | switch NAME | next
"""
import pathlib
import subprocess
import sys

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Adw, Gdk, GdkPixbuf, Gio, GLib, Gtk, Pango  # noqa: E402

from . import spaces, ui  # noqa: E402

PALETTE = ["#f28dc4", "#9b6cf0", "#5aa6ff", "#4fd1c0", "#6fae7c", "#c9a85c", "#f0935a", "#c25d6a", "#8a8a93"]


def color_css(widget, color, prop="background"):
    prov = Gtk.CssProvider()
    prov.load_from_string(f"* {{ {prop}: {color}; }}")
    # above USER priority: ~/.config/gtk-4.0/gtk.css styles every button and would win otherwise
    widget.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1)


_THUMBS = {}


def thumb_picture(path, w, h):
    """Gtk.Picture showing a small cover-cropped copy, so a 4K wallpaper doesn't set the layout width."""
    pic = Gtk.Picture(content_fit=Gtk.ContentFit.COVER, can_shrink=True, width_request=w, height_request=h,
                      hexpand=False)
    if path:
        key = (str(path), w, h)
        if key not in _THUMBS:
            try:
                src = GdkPixbuf.Pixbuf.new_from_file(str(path))
                # cover-crop to the w:h aspect, then scale to exactly w x h (its natural size)
                sw, sh = src.get_width(), src.get_height()
                cw, ch = (sw, int(sw * h / w)) if sw * h / w <= sh else (int(sh * w / h), sh)
                crop = src.new_subpixbuf((sw - cw) // 2, (sh - ch) // 2, cw, ch)
                _THUMBS[key] = Gdk.Texture.new_for_pixbuf(crop.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR))
            except GLib.Error:
                _THUMBS[key] = None
        if _THUMBS[key] is not None:
            pic.set_paintable(_THUMBS[key])
    return pic


def app_info(app_id):
    """DesktopAppInfo or None (the constructor raises for apps that are not installed)."""
    try:
        return Gio.DesktopAppInfo.new(app_id)
    except TypeError:
        return None


def wallpapers():
    out = []
    if spaces.WALLPAPER_DIR.is_dir():
        out = sorted(p.stem for p in spaces.WALLPAPER_DIR.glob("*.png"))
    return out or ["orbit-glass", "orbit-lagoon", "orbit-graphite", "orbit-light"]


def wallpaper_path(name):
    p = pathlib.Path(name)
    if p.is_absolute():
        return p
    p = spaces.WALLPAPER_DIR / f"{name}.png"
    if p.exists():
        return p
    alt = pathlib.Path.home() / "brand/wallpapers" / f"{name}.png"  # screenshot test environment
    return alt if alt.exists() else None


class SpaceCard(Gtk.Box):
    def __init__(self, win, space, current):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=0, css_classes=["orbit-card"],
                         width_request=280)
        self.set_overflow(Gtk.Overflow.HIDDEN)
        pic = thumb_picture(wallpaper_path(space["wallpaper"]), 280, 140)
        frame = Gtk.Overlay(child=pic)
        stripe = Gtk.Box(height_request=6, valign=Gtk.Align.END)
        color_css(stripe, space["color"])
        frame.add_overlay(stripe)
        if current:
            pill = Gtk.Label(label="Current", css_classes=["orbit-pill", "orbit-lit"], halign=Gtk.Align.END,
                             valign=Gtk.Align.START, margin_top=10, margin_end=10)
            frame.add_overlay(pill)
        self.append(frame)
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, margin_top=14, margin_start=4,
                       margin_end=4)
        title = Gtk.Box(spacing=8)
        dot = Gtk.Box(css_classes=["orbit-sidebar-dot"], valign=Gtk.Align.CENTER)
        color_css(dot, space["color"])
        title.append(dot)
        title.append(Gtk.Label(label=space["name"], css_classes=["title-3"], xalign=0, hexpand=True,
                               ellipsize=Pango.EllipsizeMode.END))
        body.append(title)
        bits = [f"{len(space['apps'])} dock app{'s' if len(space['apps']) != 1 else ''}",
                "Do not disturb" if space["dnd"] else "Notifications on"]
        body.append(Gtk.Label(label=" · ".join(bits), xalign=0, css_classes=["dim-label", "caption"]))
        icons = Gtk.Box(spacing=6, margin_top=4)
        for app_id in space["apps"][:7]:
            info = app_info(app_id)
            img = Gtk.Image(pixel_size=28)
            if info and info.get_icon():
                img.set_from_gicon(info.get_icon())
                img.set_tooltip_text(info.get_display_name())
            else:
                img.set_from_icon_name("application-x-executable-symbolic")
                img.set_tooltip_text(app_id)
            icons.append(img)
        body.append(icons)
        btns = Gtk.Box(spacing=8, margin_top=10)
        sw = Gtk.Button(label="Current Space" if current else "Switch", hexpand=True, sensitive=not current,
                        css_classes=[] if current else ["suggested-action"])
        sw.connect("clicked", lambda *_: win.switch(space["name"]))
        ed = Gtk.Button(icon_name="document-edit-symbolic", tooltip_text="Edit")
        ed.connect("clicked", lambda *_: win.edit(space))
        op = Gtk.Button(icon_name="folder-open-symbolic", tooltip_text="Open folder")
        op.connect("clicked", lambda *_: win.open_folder(space))
        for b in (sw, op, ed):
            btns.append(b)
        body.append(btns)
        self.append(body)


class AppPicker(Adw.Dialog):
    """Searchable list of installed apps; callback(app_id)."""

    def __init__(self, callback, exclude=()):
        super().__init__(title="Add App", content_width=420, content_height=560)
        self.cb = callback
        entry = Gtk.SearchEntry(placeholder_text="Search apps", margin_start=12, margin_end=12, margin_top=6,
                                margin_bottom=6)
        lb = Gtk.ListBox(css_classes=["boxed-list"], margin_start=12, margin_end=12, margin_bottom=12)
        apps = sorted((a for a in Gio.AppInfo.get_all() if a.should_show() and a.get_id() not in exclude),
                      key=lambda a: a.get_display_name().lower())
        rows = []
        for a in apps:
            r = Adw.ActionRow(title=a.get_display_name(), subtitle=a.get_description() or "", activatable=True)
            r.set_subtitle_lines(1)
            img = Gtk.Image(pixel_size=32)
            if a.get_icon():
                img.set_from_gicon(a.get_icon())
            r.add_prefix(img)
            r.connect("activated", lambda _r, aid=a.get_id(): (self.cb(aid), self.close()))
            r._name = a.get_display_name().lower()
            lb.append(r)
            rows.append(r)
        lb.set_filter_func(lambda r: entry.get_text().lower() in r._name)
        entry.connect("search-changed", lambda *_: lb.invalidate_filter())
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.append(entry)
        box.append(Gtk.ScrolledWindow(child=lb, vexpand=True))
        if not rows:
            box.append(Adw.StatusPage(title="No apps found", icon_name="application-x-executable-symbolic"))
        tv = Adw.ToolbarView(content=box)
        tv.add_top_bar(Adw.HeaderBar())
        self.set_child(tv)


class EditDialog(Adw.Dialog):
    def __init__(self, win, space, is_new=False):
        super().__init__(title="New Space" if is_new else f"Edit {space['name']}", content_width=480,
                         content_height=680)
        self.win, self.orig, self.space, self.is_new = win, space.get("name"), dict(space), is_new
        self.space["apps"] = list(space.get("apps", []))
        page = Adw.PreferencesPage()

        g = Adw.PreferencesGroup()
        self.name = Adw.EntryRow(title="Name", text=self.space["name"])
        g.add(self.name)
        color_row = Adw.ActionRow(title="Color")
        sw_box = Gtk.Box(spacing=6, valign=Gtk.Align.CENTER)
        self._swatches = []
        for c in PALETTE:
            b = Gtk.ToggleButton(css_classes=["orbit-swatch", "circular"], tooltip_text=c,
                                 active=c.lower() == self.space["color"].lower())
            color_css(b, c)
            b.connect("toggled", self._pick_color, c)
            sw_box.append(b)
            self._swatches.append(b)
        color_row.add_suffix(sw_box)
        g.add(color_row)
        page.add(g)

        g2 = Adw.PreferencesGroup(title="Wallpaper")
        flow = Gtk.FlowBox(max_children_per_line=4, selection_mode=Gtk.SelectionMode.SINGLE,
                           column_spacing=8, row_spacing=8, homogeneous=True)
        for wpname in wallpapers():
            pic = thumb_picture(wallpaper_path(wpname), 96, 56)
            pic.add_css_class("card")
            pic.set_tooltip_text(wpname.replace("orbit-", "").title())
            child = Gtk.FlowBoxChild(child=pic)
            child._wp = wpname
            flow.append(child)
            if wpname == self.space["wallpaper"]:
                flow.select_child(child)
        flow.connect("child-activated", lambda f, c: self.space.__setitem__("wallpaper", c._wp))
        flow.connect("selected-children-changed",
                     lambda f: f.get_selected_children() and self.space.__setitem__(
                         "wallpaper", f.get_selected_children()[0]._wp))
        g2.add(flow)
        page.add(g2)

        g3 = Adw.PreferencesGroup()
        self.dnd = Adw.SwitchRow(title="Do not disturb", subtitle="Hide notification banners in this Space",
                                 active=self.space["dnd"])
        g3.add(self.dnd)
        page.add(g3)

        self.apps_group = Adw.PreferencesGroup(title="Dock apps", description="Pinned in the dock in this Space")
        add = Gtk.Button(icon_name="list-add-symbolic", css_classes=["flat"], tooltip_text="Add app",
                         valign=Gtk.Align.CENTER)
        add.connect("clicked", lambda *_: AppPicker(self._add_app, self.space["apps"]).present(self))
        self.apps_group.set_header_suffix(add)
        page.add(self.apps_group)
        self._app_rows = []
        self._fill_apps()

        if not is_new:
            g4 = Adw.PreferencesGroup()
            delete = Adw.ButtonRow(title="Delete Space") if hasattr(Adw, "ButtonRow") else None
            if delete is None:
                delete = Gtk.Button(label="Delete Space", css_classes=["destructive-action"], halign=Gtk.Align.CENTER)
                delete.connect("clicked", lambda *_: self._delete())
                g4.add(delete)
            page.add(g4)

        hb = Adw.HeaderBar(show_end_title_buttons=False, show_start_title_buttons=False)
        cancel = Gtk.Button(label="Cancel")
        cancel.connect("clicked", lambda *_: self.close())
        save = Gtk.Button(label="Create" if is_new else "Save", css_classes=["suggested-action"])
        save.connect("clicked", lambda *_: self._save())
        hb.pack_start(cancel)
        hb.pack_end(save)
        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(hb)
        self.set_child(tv)

    def _pick_color(self, btn, color):
        if btn.get_active():
            self.space["color"] = color
            for b in self._swatches:
                if b is not btn:
                    b.set_active(False)

    def _fill_apps(self):
        for r in self._app_rows:
            self.apps_group.remove(r)
        self._app_rows = []
        for i, app_id in enumerate(self.space["apps"]):
            info = app_info(app_id)
            r = Adw.ActionRow(title=info.get_display_name() if info else app_id,
                              subtitle="" if info else "not installed")
            img = Gtk.Image(pixel_size=32)
            if info and info.get_icon():
                img.set_from_gicon(info.get_icon())
            r.add_prefix(img)
            up = Gtk.Button(icon_name="go-up-symbolic", css_classes=["flat"], valign=Gtk.Align.CENTER,
                            sensitive=i > 0, tooltip_text="Move up")
            up.connect("clicked", lambda *_a, i=i: self._move(i, -1))
            rm = Gtk.Button(icon_name="list-remove-symbolic", css_classes=["flat"], valign=Gtk.Align.CENTER,
                            tooltip_text="Remove")
            rm.connect("clicked", lambda *_a, i=i: self._remove(i))
            r.add_suffix(up)
            r.add_suffix(rm)
            self.apps_group.add(r)
            self._app_rows.append(r)

    def _add_app(self, app_id):
        if app_id not in self.space["apps"]:
            self.space["apps"].append(app_id)
            self._fill_apps()

    def _move(self, i, d):
        a = self.space["apps"]
        a[i + d], a[i] = a[i], a[i + d]
        self._fill_apps()

    def _remove(self, i):
        del self.space["apps"][i]
        self._fill_apps()

    def _save(self):
        self.space["name"] = self.name.get_text().strip()
        self.space["dnd"] = self.dnd.get_active()
        try:
            v = spaces.validate(self.space)
        except ValueError:
            ui.toast(self.win, "Give the Space a name without “/”")
            return
        self.win.save_space(self.orig, v, self.is_new)
        self.close()

    def _delete(self):
        ui.confirm(self.win, f"Delete “{self.orig}”?",
                   "The Space is removed from the list. Its folder and files stay where they are.",
                   "Delete", lambda: (self.win.delete_space(self.orig), self.close()))


class SpacesWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Spaces", default_width=980, default_height=640)
        self._toasts = Adw.ToastOverlay()
        hb = Adw.HeaderBar()
        add = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="New Space")
        add.connect("clicked", lambda *_: self.new_space())
        hb.pack_start(add)
        menu = Gio.Menu()
        menu.append("Reset to Personal / Work / Study", "win.reset")
        menu.append("About Orbit Spaces", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))
        for name, cb in {"reset": self.reset, "about": lambda: ui.about(
                self, "Orbit Spaces", "orbit-spaces", "One click changes folder, wallpaper, dock and notifications.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        self.flow = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, homogeneous=True, column_spacing=18,
                                row_spacing=18, max_children_per_line=4, min_children_per_line=1,
                                margin_top=24, margin_bottom=24, margin_start=24, margin_end=24,
                                valign=Gtk.Align.START)
        intro = Gtk.Label(label="A Space bundles a folder, a wallpaper, the apps in your dock and whether "
                                "notifications pop up. Switch with one click, from Control Center, or with "
                                "Super+Alt+1, 2, 3.", wrap=True, xalign=0, css_classes=["dim-label"],
                          margin_start=24, margin_end=24, margin_top=18)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.append(intro)
        box.append(self.flow)
        tv = Adw.ToolbarView(content=Gtk.ScrolledWindow(child=box))
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        self.refresh()

    def refresh(self):
        self.spaces, self.current = spaces.load()
        while (c := self.flow.get_first_child()) is not None:
            self.flow.remove(c)
        for s in self.spaces:
            self.flow.append(SpaceCard(self, s, s["name"] == self.current))

    def switch(self, name):
        try:
            spaces.switch(name)
        except (KeyError, OSError) as e:
            ui.toast(self, str(e))
            return
        ui.toast(self, f"Switched to {name}")
        self.refresh()

    def edit(self, space):
        EditDialog(self, space).present(self)

    def new_space(self):
        EditDialog(self, {"name": "", "color": PALETTE[len(self.spaces) % len(PALETTE)],
                          "wallpaper": "orbit-glass", "dnd": False,
                          "apps": ["orbit-files.desktop", "firefox-esr.desktop"]}, is_new=True).present(self)

    def save_space(self, orig, new, is_new):
        names = [s["name"].lower() for s in self.spaces if s["name"] != orig]
        if new["name"].lower() in names:
            ui.toast(self, f"There is already a Space called “{new['name']}”")
            return
        if is_new:
            self.spaces.append(new)
        else:
            self.spaces = [new if s["name"] == orig else s for s in self.spaces]
            old_dir = spaces.folder({"name": orig})
            if orig != new["name"] and old_dir.is_dir() and not spaces.folder(new).exists():
                old_dir.rename(spaces.folder(new))  # keep files with the renamed Space
        current = new["name"] if self.current == orig else self.current
        spaces.folder(new).mkdir(parents=True, exist_ok=True)
        spaces.save(self.spaces, current)
        if current == new["name"] and not is_new:
            spaces.switch(new["name"])  # re-apply edited dock/wallpaper right away
        self.refresh()

    def delete_space(self, name):
        if len(self.spaces) <= 1:
            ui.toast(self, "Keep at least one Space")
            return
        self.spaces = [s for s in self.spaces if s["name"] != name]
        spaces.save(self.spaces, None if self.current == name else self.current)
        self.refresh()

    def reset(self):
        spaces.save([dict(s) for s in spaces.DEFAULT], self.current)
        self.refresh()

    def open_folder(self, space):
        d = spaces.folder(space)
        d.mkdir(parents=True, exist_ok=True)
        ui.spawn(["orbit-files", str(d)])


class SpacesApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Spaces", lambda app: SpacesWindow(app))


def cli(argv):
    sp, cur = spaces.load()
    cmd = argv[0] if argv else "list"
    if cmd == "list":
        for s in sp:
            print(("* " if s["name"] == cur else "  ") + s["name"])
    elif cmd == "current":
        print(cur or "")
    elif cmd == "switch" and len(argv) == 2:
        spaces.switch(argv[1])
    elif cmd == "next":
        names = [s["name"] for s in sp]
        nxt = names[(names.index(cur) + 1) % len(names)] if cur in names else names[0]
        spaces.switch(nxt)
        print(nxt)
    elif cmd.isdigit():
        i = int(cmd) - 1
        if 0 <= i < len(sp):
            spaces.switch(sp[i]["name"])
    else:
        print(__doc__.split("CLI", 1)[1].strip(), file=sys.stderr)
        return 2
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("list", "current", "switch", "next") or \
            (len(sys.argv) > 1 and sys.argv[1].isdigit()):
        try:
            return cli(sys.argv[1:])
        except KeyError as e:
            print(e, file=sys.stderr)
            return 1
    return SpacesApp().run_main()
