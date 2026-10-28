"""Orbit Notes — Markdown notes in ~/Home/Notes.

Every note is a plain .md file, so any editor or sync tool works with them.
Sidebar: search, folders, pinned notes first. Editor: Markdown highlighting
(GtkSourceView), autosave, live word count, and a rendered preview.
"""
import pathlib

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("GtkSource", "5")
from gi.repository import Adw, Gio, GLib, GObject, Gtk, GtkSource, Pango  # noqa: E402

from . import notes, ui  # noqa: E402

SAVE_DELAY_MS = 600


class NoteRow(Gtk.ListBoxRow):
    def __init__(self, store, path):
        super().__init__()
        self.path = path
        try:
            text = path.read_text(errors="replace")
        except OSError:
            text = ""
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2, margin_top=8, margin_bottom=8,
                      margin_start=10, margin_end=10)
        top = Gtk.Box(spacing=6)
        title = Gtk.Label(label=notes.title_of(text, path.stem), xalign=0, hexpand=True,
                          ellipsize=Pango.EllipsizeMode.END, css_classes=["heading"])
        top.append(title)
        if store.is_pinned(path):
            top.append(Gtk.Image(icon_name="view-pin-symbolic", css_classes=["dim-label"]))
        box.append(top)
        snip = notes.snippet(text)
        if snip:
            box.append(Gtk.Label(label=snip, xalign=0, ellipsize=Pango.EllipsizeMode.END, lines=2, wrap=True,
                                 css_classes=["dim-label", "caption"]))
        meta = notes.relative_time(path.stat().st_mtime)
        folder = path.parent.relative_to(store.root)
        if str(folder) != ".":
            meta += f" · {folder}"
        box.append(Gtk.Label(label=meta, xalign=0, css_classes=["caption", "orbit-faint"]))
        self.set_child(box)


class NotesWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Notes", default_width=1100, default_height=720)
        self.store = notes.NoteStore()
        self.current = None
        self._dirty = False
        self._save_id = 0
        self._loading = False
        self.folder = None
        self._toasts = Adw.ToastOverlay()

        # ---- sidebar
        self.search = Gtk.SearchEntry(placeholder_text="Search notes", margin_start=8, margin_end=8,
                                      margin_top=4)
        self.search.connect("search-changed", lambda *_: self.refresh_list())
        self.folders = Gtk.DropDown(margin_start=8, margin_end=8, margin_top=6, margin_bottom=6)
        self.folders.connect("notify::selected", self._on_folder)
        self.list = Gtk.ListBox(css_classes=["navigation-sidebar"])
        self.list.connect("row-selected", self._on_row)
        self.list_empty = Adw.StatusPage(icon_name="document-edit-symbolic", title="No notes yet",
                                         description="Press Ctrl+N to write one.")
        self.list_stack = Gtk.Stack()
        self.list_stack.add_named(Gtk.ScrolledWindow(child=self.list, vexpand=True), "list")
        self.list_stack.add_named(self.list_empty, "empty")
        side = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        side.append(self.search)
        side.append(self.folders)
        side.append(self.list_stack)
        side_tv = Adw.ToolbarView()
        sh = Adw.HeaderBar(show_title=False)
        sh.pack_start(Gtk.Label(label="Notes", css_classes=["heading"], margin_start=6))
        new = Gtk.Button(icon_name="document-new-symbolic", tooltip_text="New note (Ctrl+N)",
                         action_name="win.new")
        sh.pack_end(new)
        side_tv.add_top_bar(sh)
        side_tv.set_content(side)

        # ---- editor
        self.buffer = GtkSource.Buffer()
        lm = GtkSource.LanguageManager.get_default()
        self.buffer.set_language(lm.get_language("markdown"))
        self._apply_scheme()
        Adw.StyleManager.get_default().connect("notify::dark", lambda *_: self._apply_scheme())
        self.buffer.connect("changed", self._on_changed)
        self.view = GtkSource.View(buffer=self.buffer, wrap_mode=Gtk.WrapMode.WORD_CHAR, monospace=False,
                                   top_margin=24, bottom_margin=48, left_margin=36, right_margin=36,
                                   css_classes=["orbit-editor"], auto_indent=True,
                                   smart_home_end=GtkSource.SmartHomeEndType.BEFORE, pixels_below_lines=4)
        clamp = Adw.Clamp(child=self.view, maximum_size=820, tightening_threshold=600)
        self.preview = Gtk.Label(wrap=True, xalign=0, yalign=0, selectable=False, use_markup=True,
                                 margin_top=24, margin_bottom=48, margin_start=36, margin_end=36,
                                 wrap_mode=Pango.WrapMode.WORD_CHAR, css_classes=["orbit-editor"])
        self.preview.connect("activate-link", lambda l, uri: ui.spawn(["xdg-open", uri]) or True)
        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        self.stack.add_named(Gtk.ScrolledWindow(child=clamp), "edit")
        self.stack.add_named(Gtk.ScrolledWindow(child=Adw.Clamp(child=self.preview, maximum_size=820)), "preview")
        self.stack.add_named(Adw.StatusPage(icon_name="orbit-notes", title="Orbit Notes",
                                            description="Pick a note on the left, or press Ctrl+N."), "none")

        self.title_label = Adw.WindowTitle(title="Notes")
        hb = Adw.HeaderBar(title_widget=self.title_label)
        self.pin = Gtk.ToggleButton(icon_name="view-pin-symbolic", tooltip_text="Pin note")
        self.pin.connect("toggled", self._on_pin)
        self.prev_btn = Gtk.ToggleButton(icon_name="view-reveal-symbolic", tooltip_text="Preview (Ctrl+P)")
        self.prev_btn.connect("toggled", lambda b: self.set_preview(b.get_active()))
        menu = Gio.Menu()
        m1 = Gio.Menu()
        m1.append("Rename…", "win.rename")
        m1.append("Move to Folder…", "win.move")
        m1.append("New Folder…", "win.new-folder")
        menu.append_section(None, m1)
        m2 = Gio.Menu()
        m2.append("Show in Files", "win.reveal")
        m2.append("Move to Trash", "win.trash")
        menu.append_section(None, m2)
        m3 = Gio.Menu()
        m3.append("About Orbit Notes", "win.about")
        menu.append_section(None, m3)
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))
        hb.pack_end(self.prev_btn)
        hb.pack_end(self.pin)
        self.status = Gtk.Label(xalign=0, css_classes=["caption", "dim-label"], margin_start=12, margin_end=12,
                                margin_top=4, margin_bottom=4)
        content = Adw.ToolbarView()
        content.add_top_bar(hb)
        content.set_content(self.stack)
        content.add_bottom_bar(self.status)

        self.split = Adw.NavigationSplitView(
            sidebar=Adw.NavigationPage(child=side_tv, title="Notes"),
            content=Adw.NavigationPage(child=content, title="Note"), min_sidebar_width=260,
            max_sidebar_width=340)
        bp = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 640sp"))
        bp.add_setter(self.split, "collapsed", True)
        self.add_breakpoint(bp)
        self._toasts.set_child(self.split)
        self.set_content(self._toasts)

        for name, cb in {"new": self.new_note, "rename": self.rename, "move": self.move, "trash": self.trash,
                         "reveal": self.reveal, "new-folder": self.new_folder,
                         "preview": lambda: self.prev_btn.set_active(not self.prev_btn.get_active()),
                         "search": lambda: self.search.grab_focus(),
                         "about": lambda: ui.about(self, "Orbit Notes", "orbit-notes",
                                                   "Plain Markdown notes in ~/Home/Notes.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)

        self.monitor = Gio.File.new_for_path(str(self.store.root)).monitor_directory(
            Gio.FileMonitorFlags.WATCH_MOVES, None)
        self.monitor.connect("changed", self._on_disk_change)
        self.connect("close-request", lambda *_: (self.flush(), False)[1])
        self.refresh_folders()
        self.refresh_list(select_first=True)

    # ---- style
    def _apply_scheme(self):
        sm = GtkSource.StyleSchemeManager.get_default()
        dark = Adw.StyleManager.get_default().get_dark()
        scheme = sm.get_scheme("Adwaita-dark" if dark else "Adwaita") or sm.get_scheme("classic")
        self.buffer.set_style_scheme(scheme)

    # ---- list
    def refresh_folders(self):
        names = ["All notes"] + self.store.folders()
        self._folder_names = names
        self.folders.set_model(Gtk.StringList.new(names))
        self.folders.set_selected(names.index(self.folder) if self.folder in names else 0)

    def _on_folder(self, dd, _p):
        i = dd.get_selected()
        names = getattr(self, "_folder_names", ["All notes"])
        self.folder = None if i in (0, Gtk.INVALID_LIST_POSITION) or i >= len(names) else names[i]
        self.refresh_list()

    def refresh_list(self, select_first=False):
        keep = self.current
        self._refreshing = True
        while (r := self.list.get_row_at_index(0)) is not None:
            self.list.remove(r)
        found = self.store.notes(self.folder, self.search.get_text())
        for p in found:
            row = NoteRow(self.store, p)
            self.list.append(row)
            if keep and p == keep:
                self.list.select_row(row)
        self._refreshing = False
        self.list_stack.set_visible_child_name("list" if found else "empty")
        self.list_empty.set_title("No matches" if self.search.get_text() else "No notes yet")
        if select_first and found and not keep:
            self.list.select_row(self.list.get_row_at_index(0))

    def _on_row(self, _lb, row):
        if getattr(self, "_refreshing", False) or row is None:
            return
        self.open(row.path)
        self.split.set_show_content(True)

    def _on_disk_change(self, mon, f, other, event):
        if event in (Gio.FileMonitorEvent.CHANGES_DONE_HINT, Gio.FileMonitorEvent.DELETED,
                     Gio.FileMonitorEvent.CREATED, Gio.FileMonitorEvent.MOVED_IN,
                     Gio.FileMonitorEvent.MOVED_OUT, Gio.FileMonitorEvent.RENAMED):
            if f.get_basename().startswith("."):
                return
            GLib.timeout_add(250, self._external_refresh)

    def _external_refresh(self):
        if self.current and not self._dirty and self.current.exists():
            text = self.current.read_text(errors="replace")
            if text != self._get_text():
                self._load_text(text)  # edited elsewhere (e.g. synced): show the new version
        self.refresh_list()
        return False

    # ---- editing
    def _get_text(self):
        return self.buffer.get_text(self.buffer.get_start_iter(), self.buffer.get_end_iter(), True)

    def _load_text(self, text):
        self._loading = True
        self.buffer.begin_irreversible_action()
        self.buffer.set_text(text)
        self.buffer.end_irreversible_action()
        self.buffer.place_cursor(self.buffer.get_end_iter())
        self._loading = False
        self._update_status()

    def open(self, path):
        if path == self.current:
            return
        self.flush()
        self.current = pathlib.Path(path)
        self._load_text(self.current.read_text(errors="replace"))
        self.pin.handler_block_by_func(self._on_pin)
        self.pin.set_active(self.store.is_pinned(self.current))
        self.pin.handler_unblock_by_func(self._on_pin)
        self.title_label.set_title(notes.title_of(self._get_text(), self.current.stem))
        rel = self.current.parent.relative_to(self.store.root)
        self.title_label.set_subtitle("" if str(rel) == "." else str(rel))
        self.set_preview(self.prev_btn.get_active())
        if not self.prev_btn.get_active():
            self.view.grab_focus()

    def _on_changed(self, *_):
        if self._loading or self.current is None:
            return
        self._dirty = True
        if self._save_id:
            GLib.source_remove(self._save_id)
        self._save_id = GLib.timeout_add(SAVE_DELAY_MS, self.flush)
        self._update_status("Editing…")

    def flush(self):
        if self._save_id:
            GLib.source_remove(self._save_id)
            self._save_id = 0
        if self._dirty and self.current is not None:
            try:
                self.store.save(self.current, self._get_text())
                self._dirty = False
                self._update_status("Saved")
                self.title_label.set_title(notes.title_of(self._get_text(), self.current.stem))
            except OSError as e:
                ui.toast(self, f"Could not save: {e.strerror}")
        return False

    def _update_status(self, state=None):
        if self.current is None:
            self.stack.set_visible_child_name("none")
            self.status.set_label("")
            return
        text = self._get_text()
        wc = notes.word_count(text)
        mins = max(1, round(wc / 220))
        self.status.set_label(f"{wc} word{'s' if wc != 1 else ''} · {mins} min read"
                              + (f" · {state}" if state else ""))

    def set_preview(self, on):
        if self.current is None:
            self.stack.set_visible_child_name("none")
            return
        if on:
            self.flush()
            self.preview.set_markup(notes.markdown_to_pango(self._get_text()))
        self.stack.set_visible_child_name("preview" if on else "edit")

    def _on_pin(self, btn):
        if self.current:
            self.store.set_pinned(self.current, btn.get_active())
            self.refresh_list()

    # ---- actions
    def new_note(self):
        self.flush()
        p = self.store.create("Untitled", folder=self.folder)
        self.search.set_text("")
        self.refresh_list()
        self.open(p)
        self.refresh_list()
        self.prev_btn.set_active(False)
        # select the title text so typing replaces "Untitled"
        start = self.buffer.get_iter_at_offset(2)
        end = self.buffer.get_iter_at_offset(10)
        self.buffer.select_range(start, end)
        self.view.grab_focus()

    def new_folder(self):
        def do(name):
            safe = notes.safe_filename(name)
            if safe:
                (self.store.root / safe).mkdir(exist_ok=True)
                self.folder = safe
                self.refresh_folders()
        ui.ask_text(self, "New Folder", "Ideas", "Create", do)

    def rename(self):
        if not self.current:
            return
        self.flush()

        def do(title):
            try:
                self.current = self.store.rename(self.current, title)
                self.refresh_list()
            except (ValueError, FileExistsError) as e:
                ui.toast(self, str(e))
        ui.ask_text(self, "Rename Note", self.current.stem, "Rename", do)

    def move(self):
        if not self.current:
            return
        self.flush()
        d = Adw.AlertDialog(heading="Move to Folder")
        choices = ["(No folder)"] + self.store.folders()
        dd = Gtk.DropDown(model=Gtk.StringList.new(choices))
        d.set_extra_child(dd)
        d.add_response("cancel", "Cancel")
        d.add_response("ok", "Move")
        d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED)

        def resp(_d, r):
            if r != "ok":
                return
            i = dd.get_selected()
            dest = self.store.root if i == 0 else self.store.root / choices[i]
            target = dest / self.current.name
            if target.exists():
                ui.toast(self, "A note with that name is already in that folder")
                return
            pinned = self.store.is_pinned(self.current)
            self.store.set_pinned(self.current, False)
            self.current.rename(target)
            self.current = target
            if pinned:
                self.store.set_pinned(target, True)
            self.refresh_folders()
            self.refresh_list()
        d.connect("response", resp)
        d.present(self)

    def trash(self):
        if not self.current:
            return
        self.flush()
        p = self.current
        try:
            Gio.File.new_for_path(str(p)).trash(None)
        except GLib.Error as e:
            ui.toast(self, e.message)
            return
        self.store.set_pinned(p, False)
        self.current = None
        self._load_text("")
        self.current = None
        self.refresh_list(select_first=True)
        if self.current is None:
            self._update_status()
        t = Adw.Toast(title="Note moved to the trash", button_label="Undo", timeout=6)
        t.connect("button-clicked", lambda *_: self._restore(p))
        self._toasts.add_toast(t)

    def _restore(self, p):
        trash = Gio.File.new_for_uri("trash:///")
        for info in trash.enumerate_children("standard::name,trash::orig-path", Gio.FileQueryInfoFlags.NONE, None):
            if info.get_attribute_byte_string("trash::orig-path") == str(p):
                trash.get_child(info.get_name()).move(Gio.File.new_for_path(str(p)), Gio.FileCopyFlags.NONE,
                                                      None, None)
                self.refresh_list()
                self.open(p)
                return

    def reveal(self):
        target = self.current or self.store.root
        ui.spawn(["orbit-files", str(target.parent if target.is_file() else target)])


class NotesApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Notes", lambda app: NotesWindow(app))
        self.connect("startup", lambda *_: ui.add_shortcuts(self, {
            "win.new": ["<Ctrl>n"], "win.preview": ["<Ctrl>p"], "win.search": ["<Ctrl>f"],
            "win.rename": ["F2"], "win.trash": ["<Ctrl>Delete"]}))


def main():
    return NotesApp().run_main()
