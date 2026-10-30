"""Orbit Files — the Orbit OS file manager.

Tabs, a sidebar with Places / Spaces / Devices / Trash, grid and list views,
a preview pane, search (this folder or all of ~/Home), drag and drop, cut /
copy / paste that interoperates with other apps, rename, trash and restore,
compress / extract, properties, "Move to Space" and one-click Inbox sorting.

Built on Gtk.DirectoryList, so folders update live and load asynchronously.
"""
import os
import pathlib
import shutil
import subprocess
import tarfile
import threading
import time
import zipfile

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Adw, Gdk, GdkPixbuf, Gio, GLib, GObject, Gtk, Pango  # noqa: E402

from . import fileops, paths, spaces, ui  # noqa: E402

ATTRS = ",".join(["standard::name", "standard::display-name", "standard::icon", "standard::type",
                  "standard::size", "standard::is-hidden", "standard::is-backup", "standard::content-type",
                  "standard::symbolic-icon", "time::modified", "thumbnail::path", "unix::mode",
                  "trash::orig-path", "trash::deletion-date", "standard::target-uri"])
TRASH = "trash:///"
ARCHIVE_SUFFIXES = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.xz", ".txz", ".tar.bz2", ".tbz2")
TEXT_PREVIEW_BYTES = 64 * 1024
THUMB_MAX_BYTES = 60 * 1024 * 1024


class Thumbnails:
    """Small in-memory thumbnails for images that have no system thumbnail yet.
    Decoded in a worker thread (one at a time) so scrolling never blocks."""

    def __init__(self, size=128):
        self.size, self.cache, self.waiting = size, {}, {}
        self.queue, self.lock = [], threading.Lock()
        self.busy = False

    def get(self, path, mtime, callback):
        key = (path, mtime)
        if key in self.cache:
            return self.cache[key]
        with self.lock:
            self.waiting.setdefault(key, []).append(callback)
            if len(self.waiting[key]) == 1:
                self.queue.append(key)
            if not self.busy:
                self.busy = True
                threading.Thread(target=self._work, daemon=True).start()
        return None

    def _work(self):
        while True:
            with self.lock:
                if not self.queue:
                    self.busy = False
                    return
                key = self.queue.pop()  # newest request first: what is on screen now
            tex = None
            try:
                if os.path.getsize(key[0]) <= THUMB_MAX_BYTES:
                    pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(key[0], self.size, self.size, True)
                    pb = pb.apply_embedded_orientation() or pb
                    tex = Gdk.Texture.new_for_pixbuf(pb)
            except (GLib.Error, OSError):
                tex = None
            GLib.idle_add(self._deliver, key, tex)

    def _deliver(self, key, tex):
        self.cache[key] = tex
        if len(self.cache) > 2000:
            self.cache.pop(next(iter(self.cache)))
        for cb in self.waiting.pop(key, []):
            cb(tex)
        return False


THUMBS = Thumbnails()


def info_file(info):
    return info.get_attribute_object("standard::file")


def is_dir(info):
    return info.get_file_type() == Gio.FileType.DIRECTORY


def file_list_value(files):
    v = GObject.Value()
    v.init(Gdk.FileList)
    v.set_boxed(Gdk.FileList.new_from_list(files))
    return v


# ---------------------------------------------------------------- clipboard
class FileClipboard:
    """Cut/copy state shared by all windows. Also published as a Gdk.FileList
    (and text/uri-list) so other apps can paste what Orbit Files copied."""

    def __init__(self):
        self.files, self.cut = [], False

    def set(self, widget, files, cut):
        self.files, self.cut = list(files), cut
        cb = widget.get_display().get_clipboard()
        uris = "\n".join(f.get_uri() for f in files) + "\n"
        providers = [Gdk.ContentProvider.new_for_value(file_list_value(files)),
                     Gdk.ContentProvider.new_for_bytes("text/uri-list", GLib.Bytes.new(uris.encode())),
                     Gdk.ContentProvider.new_for_bytes(
                         "x-special/gnome-copied-files",
                         GLib.Bytes.new((("cut" if cut else "copy") + "\n" + uris).encode()))]
        cb.set_content(Gdk.ContentProvider.new_union(providers))

    def read(self, widget, callback):
        """callback(files, cut). Falls back to our own state if the system clipboard is foreign/empty."""
        cb = widget.get_display().get_clipboard()

        def done(c, res):
            try:
                fl = c.read_value_finish(res)
                files = fl.get_files() if fl else []
            except GLib.Error:
                files = []
            ours = [f.get_uri() for f in self.files] == [f.get_uri() for f in files]
            callback(files or self.files, self.cut if (ours or not files) else False)

        if cb.get_formats().contain_gtype(Gdk.FileList):
            cb.read_value_async(Gdk.FileList, GLib.PRIORITY_DEFAULT, None, done)
        else:
            callback(self.files, self.cut)


CLIPBOARD = FileClipboard()


# ---------------------------------------------------------------- operations
class Operation(GObject.Object):
    """One background copy / move / compress / extract job, shown in the ops bar."""
    __gsignals__ = {"progress": (GObject.SignalFlags.RUN_LAST, None, (float, str)),
                    "finished": (GObject.SignalFlags.RUN_LAST, None, (bool, str))}

    def __init__(self, title, work):
        super().__init__()
        self.title, self._work, self._cancel = title, work, threading.Event()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def cancel(self):
        self._cancel.set()

    @property
    def cancelled(self):
        return self._cancel.is_set()

    def report(self, fraction, text=""):
        GLib.idle_add(self.emit, "progress", max(0.0, min(1.0, fraction)), text)

    def _run(self):
        try:
            msg = self._work(self) or ""
            ok = not self.cancelled
        except Exception as e:  # noqa: BLE001 - shown to the user
            ok, msg = False, str(e)
        GLib.idle_add(self.emit, "finished", ok, msg if msg else ("Cancelled" if self.cancelled else ""))


def transfer_op(sources, dest, move):
    paths_ = [pathlib.Path(f.get_path()) for f in sources if f.get_path()]
    plan = fileops.plan_transfer(paths_, dest, move=move)
    total = max(1, fileops.total_bytes([s for s, _ in plan]))
    verb = "Moving" if move else "Copying"
    title = f"{verb} {len(plan)} item{'s' if len(plan) != 1 else ''}"

    def work(op):
        start = time.monotonic()

        def prog(done):
            el = max(0.001, time.monotonic() - start)
            op.report(done / total, f"{ui.human_size(done)} of {ui.human_size(total)} · {ui.human_size(done / el)}/s")
        fileops.copy_with_progress(plan, progress=prog, move=move, cancelled=lambda: op.cancelled)
        return f"{'Moved' if move else 'Copied'} {len(plan)} item{'s' if len(plan) != 1 else ''}"
    return Operation(title, work) if plan else None


def compress_op(sources, dest_dir):
    paths_ = [pathlib.Path(f.get_path()) for f in sources]
    base = paths_[0].stem if len(paths_) == 1 else "Archive"
    target = fileops.unique_name(dest_dir, f"{base}.zip")

    def work(op):
        files = []
        for p in paths_:
            if p.is_dir():
                files += [q for q in p.rglob("*") if q.is_file()]
            else:
                files.append(p)
        root = paths_[0].parent
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
            for i, f in enumerate(files):
                if op.cancelled:
                    break
                z.write(f, f.relative_to(root))
                op.report((i + 1) / max(1, len(files)), f.name)
        if op.cancelled:
            target.unlink(missing_ok=True)
        return f"Created {target.name}"
    return Operation(f"Compressing to {target.name}", work)


def extract_op(archive, dest_dir):
    a = pathlib.Path(archive.get_path())
    name = a.name
    for suf in ARCHIVE_SUFFIXES:
        if name.lower().endswith(suf):
            name = name[: -len(suf)]
            break
    target = fileops.unique_name(dest_dir, name)

    def work(op):
        target.mkdir()
        if zipfile.is_zipfile(a):
            with zipfile.ZipFile(a) as z:
                members = z.infolist()
                for i, m in enumerate(members):
                    # refuse absolute paths and ../ escapes (zip-slip)
                    dest = (target / m.filename).resolve()
                    if not dest.is_relative_to(target.resolve()):
                        raise ValueError(f"unsafe path in archive: {m.filename}")
                    z.extract(m, target)
                    op.report((i + 1) / max(1, len(members)), m.filename)
        else:
            with tarfile.open(a) as t:
                t.extractall(target, filter="data")  # blocks links/devices/escapes
        return f"Extracted to {target.name}"
    return Operation(f"Extracting {a.name}", work)


# ---------------------------------------------------------------- preview pane
class Preview(Gtk.Box):
    def __init__(self):
        super().__init__(orientation=Gtk.Orientation.VERTICAL, spacing=12, width_request=300,
                         margin_top=16, margin_bottom=16, margin_start=16, margin_end=16)
        self.picture = Gtk.Picture(content_fit=Gtk.ContentFit.CONTAIN, height_request=220, can_shrink=True)
        self.icon = Gtk.Image(pixel_size=128)
        self.text = Gtk.Label(wrap=True, xalign=0, yalign=0, selectable=True, css_classes=["orbit-mono"],
                              wrap_mode=Pango.WrapMode.WORD_CHAR, max_width_chars=40)
        self.stack = Gtk.Stack()
        self.stack.add_named(self.picture, "picture")
        self.stack.add_named(self.icon, "icon")
        sc = Gtk.ScrolledWindow(child=self.text, height_request=220, vexpand=False)
        self.stack.add_named(sc, "text")
        self.title = Gtk.Label(css_classes=["title-3"], wrap=True, justify=Gtk.Justification.CENTER,
                               wrap_mode=Pango.WrapMode.WORD_CHAR)
        self.details = Gtk.ListBox(css_classes=["boxed-list"], selection_mode=Gtk.SelectionMode.NONE)
        self.append(self.stack)
        self.append(self.title)
        self.append(self.details)
        self._token = 0

    def _row(self, k, v):
        r = Adw.ActionRow(title=k, subtitle=v, subtitle_selectable=True)
        r.add_css_class("property")
        self.details.append(r)

    def show(self, infos):
        self._token += 1
        while (c := self.details.get_first_child()) is not None:
            self.details.remove(c)
        if not infos:
            self.stack.set_visible_child_name("icon")
            self.icon.set_from_icon_name("folder-open-symbolic")
            self.title.set_label("Nothing selected")
            return
        if len(infos) > 1:
            self.stack.set_visible_child_name("icon")
            self.icon.set_from_icon_name("edit-select-all-symbolic")
            size = sum(i.get_size() for i in infos if not is_dir(i))
            self.title.set_label(f"{len(infos)} items")
            self._row("Total size (files)", ui.human_size(size))
            return
        info = infos[0]
        f = info_file(info)
        self.title.set_label(info.get_display_name())
        ctype = info.get_content_type() or ""
        kind = fileops.kind_of(info.get_name(), is_dir(info))
        self._row("Kind", f"{kind} · {Gio.content_type_get_description(ctype)}" if ctype else kind)
        if not is_dir(info):
            self._row("Size", ui.human_size(info.get_size()))
        dt = info.get_modification_date_time()
        if dt:
            self._row("Modified", dt.to_local().format("%e %b %Y, %H:%M").strip())
        if f and f.get_path():
            self._row("Location", str(pathlib.Path(f.get_path()).parent))
        orig = info.get_attribute_byte_string("trash::orig-path")
        if orig:
            self._row("Deleted from", orig)
        thumb = info.get_attribute_byte_string("thumbnail::path")
        if ctype.startswith("image/") and f and f.get_path():
            self.picture.set_filename(f.get_path())
            self.stack.set_visible_child_name("picture")
        elif thumb:
            self.picture.set_filename(thumb)
            self.stack.set_visible_child_name("picture")
        elif f and f.get_path() and (ctype.startswith("text/") or Gio.content_type_is_a(ctype, "text/plain")):
            token = self._token

            def load():
                with open(f.get_path(), "rb") as fh:
                    return fh.read(TEXT_PREVIEW_BYTES).decode(errors="replace")

            def done(txt):
                if token == self._token:
                    self.text.set_label(txt[:6000])
                    self.stack.set_visible_child_name("text")
            ui.run_async(load, done)
            self.icon.set_from_gicon(info.get_icon())
            self.stack.set_visible_child_name("icon")
        else:
            self.icon.set_from_gicon(info.get_icon())
            self.stack.set_visible_child_name("icon")


# ---------------------------------------------------------------- one folder tab
class FolderView(Gtk.Box):
    __gsignals__ = {"location-changed": (GObject.SignalFlags.RUN_LAST, None, ()),
                    "selection-changed": (GObject.SignalFlags.RUN_LAST, None, ())}

    def __init__(self, window, location):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.win = window
        self.location = location
        self.back, self.fwd = [], []
        self.show_hidden = False
        self.filter_text = ""
        self.sort_key, self.sort_desc = "name", False
        self.search_results = None  # list[Gio.File] when showing recursive search results

        self.dirlist = Gtk.DirectoryList(attributes=ATTRS, monitored=True)
        self.dirlist.connect("notify::loading", lambda *_: self._update_status())
        self.dirlist.connect("notify::error", self._on_error)
        self.results_store = Gio.ListStore(item_type=Gio.FileInfo)
        self.source = Gtk.FlattenListModel()  # switches between dirlist and results
        self._sources = Gio.ListStore(item_type=Gio.ListModel)
        self.source.set_model(self._sources)

        self.filter = Gtk.CustomFilter.new(self._filter_func)
        self.filtered = Gtk.FilterListModel(model=self.source, filter=self.filter)
        self.sorter = Gtk.CustomSorter.new(self._sort_func)
        self.sorted = Gtk.SortListModel(model=self.filtered, sorter=self.sorter)
        self.selection = Gtk.MultiSelection(model=self.sorted)
        self.selection.connect("selection-changed", lambda *_: (self._update_status(), self.emit("selection-changed")))
        self.sorted.connect("items-changed", lambda *_: self._update_status())

        self.grid = Gtk.GridView(model=self.selection, max_columns=12, min_columns=2,
                                 factory=self._grid_factory(), enable_rubberband=True)
        self.grid.connect("activate", self._on_activate)
        self.list = Gtk.ColumnView(model=self.selection, show_row_separators=False,
                                   enable_rubberband=True, css_classes=["data-table"])
        self.list.connect("activate", self._on_activate)
        for title, key, expand in (("Name", "name", True), ("Size", "size", False),
                                   ("Modified", "modified", False), ("Kind", "kind", False)):
            col = Gtk.ColumnViewColumn(title=title, factory=self._column_factory(key), expand=expand,
                                       resizable=True)
            self.list.append_column(col)

        self.views = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE, vexpand=True)
        self.views.add_named(Gtk.ScrolledWindow(child=self.grid), "grid")
        self.views.add_named(Gtk.ScrolledWindow(child=self.list), "list")
        self.empty = Adw.StatusPage(icon_name="folder-symbolic", title="This folder is empty",
                                    description="Drop files here, or use New Folder from the menu.")
        self.views.add_named(self.empty, "empty")
        self.errpage = Adw.StatusPage(icon_name="dialog-warning-symbolic", title="Can’t open this folder")
        self.views.add_named(self.errpage, "error")
        self.append(self.views)

        self.status = Gtk.Label(xalign=0, css_classes=["caption", "dim-label"], margin_start=12,
                                margin_end=12, margin_top=4, margin_bottom=4, ellipsize=Pango.EllipsizeMode.END)
        self.append(self.status)

        # background right-click + drop into this folder
        bg = Gtk.GestureClick(button=3)
        bg.connect("pressed", self._on_bg_menu)
        self.views.add_controller(bg)
        drop = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY | Gdk.DragAction.MOVE)
        drop.connect("drop", lambda t, v, x, y: self.win.drop_files(v.get_files(), self.location, t))
        self.views.add_controller(drop)

        self.view_mode = "grid"
        self.open(location, record=False)

    # ---- model plumbing
    def _filter_func(self, info):
        if not self.show_hidden and (info.get_is_hidden() or info.get_is_backup()) and self.search_results is None:
            return False
        if self.filter_text and self.search_results is None:
            return self.filter_text in info.get_display_name().lower()
        return True

    def _sort_func(self, a, b, _data=None):
        da, db = is_dir(a), is_dir(b)
        if da != db:
            return -1 if da else 1
        k = self.sort_key
        if k == "size":
            va, vb = a.get_size(), b.get_size()
        elif k == "modified":
            ta, tb = a.get_modification_date_time(), b.get_modification_date_time()
            va, vb = (ta.to_unix() if ta else 0), (tb.to_unix() if tb else 0)
        elif k == "kind":
            va, vb = fileops.kind_of(a.get_name(), da), fileops.kind_of(b.get_name(), db)
        else:
            va = GLib.utf8_collate_key_for_filename(a.get_display_name(), -1)
            vb = GLib.utf8_collate_key_for_filename(b.get_display_name(), -1)
        r = (va > vb) - (va < vb)
        if r == 0 and k != "name":
            r = (a.get_display_name().lower() > b.get_display_name().lower()) - \
                (a.get_display_name().lower() < b.get_display_name().lower())
        return -r if self.sort_desc else r

    def resort(self):
        self.sorter.changed(Gtk.SorterChange.DIFFERENT)

    def refilter(self):
        self.filter.changed(Gtk.FilterChange.DIFFERENT)
        self._update_status()

    # ---- item widgets
    def _attach_item_controllers(self, widget, list_item):
        click = Gtk.GestureClick(button=3)

        def on_menu(g, n, x, y):
            pos = list_item.get_position()
            if not self.selection.is_selected(pos):
                self.selection.select_item(pos, True)
            g.set_state(Gtk.EventSequenceState.CLAIMED)
            self.win.show_item_menu(widget, x, y)
        click.connect("pressed", on_menu)
        widget.add_controller(click)

        drag = Gtk.DragSource(actions=Gdk.DragAction.COPY | Gdk.DragAction.MOVE)

        def prepare(src, x, y):
            pos = list_item.get_position()
            if not self.selection.is_selected(pos):
                self.selection.select_item(pos, True)
            files = [info_file(i) for i in self.selected_infos()]
            src.set_icon(Gtk.WidgetPaintable(widget=widget), 16, 16)
            return Gdk.ContentProvider.new_for_value(file_list_value(files))
        drag.connect("prepare", prepare)
        widget.add_controller(drag)

        drop = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY | Gdk.DragAction.MOVE)

        def on_drop(t, value, x, y):
            info = list_item.get_item()
            if info is None or not is_dir(info):
                return False
            return self.win.drop_files(value.get_files(), info_file(info), t)

        def accept(t, drop_):
            info = list_item.get_item()
            return info is not None and is_dir(info)
        drop.connect("accept", accept)
        drop.connect("drop", on_drop)
        widget.add_controller(drop)

    def _grid_factory(self):
        f = Gtk.SignalListItemFactory()

        def setup(_f, li):
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6, width_request=104,
                          css_classes=["orbit-tile"], margin_top=4, margin_bottom=4)
            img = Gtk.Image(pixel_size=64)
            pic = Gtk.Picture(content_fit=Gtk.ContentFit.COVER, width_request=64, height_request=64,
                              can_shrink=True, visible=False, halign=Gtk.Align.CENTER)
            lbl = Gtk.Label(wrap=True, wrap_mode=Pango.WrapMode.WORD_CHAR, lines=2,
                            ellipsize=Pango.EllipsizeMode.END, justify=Gtk.Justification.CENTER,
                            max_width_chars=14)
            box.append(img)
            box.append(pic)
            box.append(lbl)
            box._img, box._pic, box._lbl = img, pic, lbl
            li.set_child(box)
            self._attach_item_controllers(box, li)

        def bind(_f, li):
            info, box = li.get_item(), li.get_child()
            box._lbl.set_label(info.get_display_name())
            thumb = info.get_attribute_byte_string("thumbnail::path")
            custom = self._custom_icon(info)
            f = info_file(info)
            ctype = info.get_content_type() or ""
            box._bound = info
            if thumb and not is_dir(info):
                box._pic.set_filename(thumb)
                box._pic.set_visible(True)
                box._img.set_visible(False)
            elif ctype.startswith("image/") and f and f.get_path():
                d = info.get_modification_date_time()

                def show(tex, box=box, info=info):
                    if tex is not None and box._bound is info:  # row may have been recycled
                        box._pic.set_paintable(tex)
                        box._pic.set_visible(True)
                        box._img.set_visible(False)
                box._img.set_from_gicon(info.get_icon())
                box._img.set_visible(True)
                box._pic.set_visible(False)
                tex = THUMBS.get(f.get_path(), d.to_unix() if d else 0, show)
                if tex is not None:
                    show(tex)
            else:
                box._pic.set_visible(False)
                box._img.set_visible(True)
                if custom:
                    box._img.set_from_icon_name(custom)
                else:
                    box._img.set_from_gicon(info.get_icon())
            box.set_tooltip_text(info.get_display_name())
        f.connect("setup", setup)
        f.connect("bind", bind)
        return f

    def _column_factory(self, key):
        f = Gtk.SignalListItemFactory()

        def setup(_f, li):
            if key == "name":
                box = Gtk.Box(spacing=10)
                img = Gtk.Image(pixel_size=24)
                lbl = Gtk.Label(xalign=0, ellipsize=Pango.EllipsizeMode.MIDDLE, hexpand=True)
                box.append(img)
                box.append(lbl)
                box._img, box._lbl = img, lbl
                li.set_child(box)
                self._attach_item_controllers(box, li)
            else:
                li.set_child(Gtk.Label(xalign=1 if key == "size" else 0, css_classes=["dim-label"]))

        def bind(_f, li):
            info, w = li.get_item(), li.get_child()
            if key == "name":
                w._lbl.set_label(info.get_display_name())
                custom = self._custom_icon(info)
                if custom:
                    w._img.set_from_icon_name(custom)
                else:
                    w._img.set_from_gicon(info.get_icon())
            elif key == "size":
                w.set_label("—" if is_dir(info) else ui.human_size(info.get_size()))
            elif key == "modified":
                d = info.get_modification_date_time()
                w.set_label(d.to_local().format("%e %b %Y %H:%M").strip() if d else "")
            else:
                w.set_label(fileops.kind_of(info.get_name(), is_dir(info)))
        f.connect("setup", setup)
        f.connect("bind", bind)
        return f

    def _custom_icon(self, info):
        """Orbit folder icons for the ~/Home layout and Spaces (Nautilus uses GIO metadata)."""
        if not is_dir(info):
            return None
        f = info_file(info)
        p = f.get_path() if f else None
        if not p:
            return None
        p = pathlib.Path(p)
        home = paths.orbit_home()
        if p.parent == home / "Spaces":
            return f"folder-space-{p.name.lower()}"
        if p.parent == home and p.name in ("Projects", "Spaces", "Notes", "Inbox"):
            return f"folder-{p.name.lower()}"
        return None

    # ---- navigation
    def open(self, location, record=True):
        if record and self.location is not None and not self.location.equal(location):
            self.back.append(self.location)
            self.fwd.clear()
        self.location = location
        self.search_results = None
        self.filter_text = ""
        self._sources.remove_all()
        self.dirlist.set_file(location)
        self._sources.append(self.dirlist)
        self.selection.unselect_all()
        self.refilter()
        self.emit("location-changed")

    def go_back(self):
        if self.back:
            self.fwd.append(self.location)
            self.open(self.back.pop(), record=False)

    def go_forward(self):
        if self.fwd:
            self.back.append(self.location)
            self.open(self.fwd.pop(), record=False)

    def go_up(self):
        parent = self.location.get_parent()
        if parent:
            self.open(parent)

    def reload(self):
        self.dirlist.set_file(None)
        self.dirlist.set_file(self.location)

    def show_search_results(self, files):
        self.search_results = files
        self.results_store.remove_all()
        for f in files:
            try:
                info = f.query_info(ATTRS, Gio.FileQueryInfoFlags.NONE, None)
            except GLib.Error:
                continue
            info.set_attribute_object("standard::file", f)
            self.results_store.append(info)
        self._sources.remove_all()
        self._sources.append(self.results_store)
        self.refilter()

    def set_view(self, mode):
        self.view_mode = mode
        self._update_status()

    def _on_activate(self, _view, pos):
        info = self.sorted.get_item(pos)
        if info is None:
            return
        f = info_file(info)
        if is_dir(info):
            self.open(f)
        elif self.location.get_uri_scheme() == "trash":
            ui.toast(self.win, "Restore the file first to open it")
        else:
            self.win.launch(f)

    def _on_bg_menu(self, g, n, x, y):
        self.selection.unselect_all()
        self.win.show_background_menu(self.views, x, y)

    def _on_error(self, *_):
        err = self.dirlist.get_error()
        if err:
            self.errpage.set_description(err.message)
        self._update_status()

    # ---- state
    def selected_infos(self):
        bs = self.selection.get_selection()
        return [self.sorted.get_item(bs.get_nth(i)) for i in range(bs.get_size())]

    def selected_files(self):
        return [info_file(i) for i in self.selected_infos()]

    def _update_status(self):
        n = self.sorted.get_n_items()
        if self.dirlist.get_error() and self.search_results is None:
            self.views.set_visible_child_name("error")
        elif n == 0 and not self.dirlist.is_loading():
            if self.search_results is not None:
                self.empty.set_title("No results")
                self.empty.set_description("Try a shorter or different search.")
                self.empty.set_icon_name("system-search-symbolic")
            elif self.location.get_uri_scheme() == "trash":
                self.empty.set_title("Trash is empty")
                self.empty.set_description("Deleted files show up here until you empty the trash.")
                self.empty.set_icon_name("user-trash-symbolic")
            else:
                self.empty.set_title("No matches" if self.filter_text else "This folder is empty")
                self.empty.set_description("" if self.filter_text else
                                           "Drop files here, or use New Folder from the menu.")
                self.empty.set_icon_name("folder-symbolic")
            self.views.set_visible_child_name("empty")
        else:
            self.views.set_visible_child_name(self.view_mode)
        sel = self.selected_infos()
        txt = f"{n} item{'s' if n != 1 else ''}"
        if self.search_results is not None:
            txt = f"{n} result{'s' if n != 1 else ''} in {self.location.get_basename()}"
        if sel:
            size = sum(i.get_size() for i in sel if not is_dir(i))
            txt += f" · {len(sel)} selected" + (f" ({ui.human_size(size)})" if size else "")
        if self.dirlist.is_loading():
            txt += " · loading…"
        self.status.set_label(txt)


# ---------------------------------------------------------------- sidebar
class Sidebar(Gtk.Box):
    def __init__(self, win):
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.win = win
        self.list = Gtk.ListBox(css_classes=["navigation-sidebar"], selection_mode=Gtk.SelectionMode.SINGLE)
        self.list.connect("row-activated", self._activated)
        self.list.set_header_func(self._header)
        sc = Gtk.ScrolledWindow(child=self.list, vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
        self.append(sc)
        self.volumes = Gio.VolumeMonitor.get()
        for sig in ("mount-added", "mount-removed", "mount-changed"):
            self.volumes.connect(sig, lambda *_: self.rebuild())
        self.rebuild()

    def _header(self, row, before):
        if before is None or before._section != row._section:
            lbl = Gtk.Label(label=row._section, xalign=0, css_classes=["caption-heading", "dim-label"],
                            margin_start=12, margin_top=12 if before else 6, margin_bottom=4)
            row.set_header(lbl)
        else:
            row.set_header(None)

    def _add(self, section, label, icon, location, color=None, extra=None, space=None):
        row = Gtk.ListBoxRow()
        box = Gtk.Box(spacing=10, margin_start=6, margin_end=6, margin_top=2, margin_bottom=2)
        if color:
            dot = Gtk.Box(css_classes=["orbit-sidebar-dot"], valign=Gtk.Align.CENTER)
            prov = Gtk.CssProvider()
            prov.load_from_string(f"box {{ background: {color}; }}")
            dot.get_style_context().add_provider(prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
            box.append(dot)
        else:
            box.append(Gtk.Image(icon_name=icon))
        box.append(Gtk.Label(label=label, xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.END))
        if extra:
            box.append(extra)
        row.set_child(box)
        row._section, row._location, row._space = section, location, space
        drop = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY | Gdk.DragAction.MOVE)
        drop.connect("drop", lambda t, v, x, y: self.win.drop_files(v.get_files(), location, t)
                     if location.get_uri_scheme() != "trash" else self.win.trash_files(v.get_files()))
        row.add_controller(drop)
        if space:
            click = Gtk.GestureClick(button=3)
            click.connect("pressed", lambda g, n, x, y: self._space_menu(row, x, y))
            row.add_controller(click)
        self.list.append(row)
        return row

    def _space_menu(self, row, x, y):
        menu = Gio.Menu()
        menu.append(f"Switch to {row._space['name']}", f"win.switch-space::{row._space['name']}")
        menu.append("Open in New Tab", f"win.open-tab::{row._location.get_uri()}")
        pop = Gtk.PopoverMenu(menu_model=menu, has_arrow=False)
        pop.set_parent(row)
        pop.set_pointing_to(Gdk.Rectangle(int(x), int(y), 1, 1))
        pop.connect("closed", lambda p: GLib.idle_add(p.unparent))
        pop.popup()

    def rebuild(self):
        while (r := self.list.get_row_at_index(0)) is not None:
            self.list.remove(r)
        home = paths.orbit_home()
        for label, rel, icon in paths.PLACES:
            p = home / rel if rel else home
            if p.exists():
                self._add("Places", label, icon, Gio.File.new_for_path(str(p)))
        sp, current = spaces.load()
        for s in sp:
            mark = Gtk.Label(label="current", css_classes=["orbit-pill"]) if s["name"] == current else None
            self._add("Spaces", s["name"], None, Gio.File.new_for_path(str(spaces.folder(s))),
                      color=s["color"], extra=mark, space=s)
        for m in self.volumes.get_mounts():
            if m.is_shadowed():
                continue
            ej = None
            if m.can_unmount() or m.can_eject():
                ej = Gtk.Button(icon_name="media-eject-symbolic", css_classes=["flat", "circular"],
                                tooltip_text="Eject", valign=Gtk.Align.CENTER)
                ej.connect("clicked", lambda _b, mm=m: self.win.eject(mm))
            self._add("Devices", m.get_name(), None, m.get_root(), extra=ej) \
                .get_child().get_first_child().set_from_gicon(m.get_symbolic_icon())
        self._add("Other", "Computer", "drive-harddisk-symbolic", Gio.File.new_for_path("/"))
        self._add("Other", "Windows Network", "network-workgroup-symbolic", Gio.File.new_for_uri("network:///"))
        self._add("Other", "Trash", "user-trash-symbolic", Gio.File.new_for_uri(TRASH))

    def _activated(self, _lb, row):
        if row._location.get_uri_scheme() in ("network", "smb"):
            # Windows PCs and shared folders: GNOME Files handles the sign-in and mounting
            ui.spawn(["nautilus", row._location.get_uri()])
            self.list.unselect_all()
            return
        self.win.current().open(row._location)

    def sync(self, location):
        i = 0
        while (row := self.list.get_row_at_index(i)) is not None:
            if row._location.equal(location):
                self.list.select_row(row)
                return
            i += 1
        self.list.unselect_all()


# ---------------------------------------------------------------- path bar
class PathBar(Gtk.Stack):
    def __init__(self, win):
        super().__init__(hhomogeneous=False, transition_type=Gtk.StackTransitionType.CROSSFADE)
        self.win = win
        self.crumbs = Gtk.Box(css_classes=["linked"])
        sc = Gtk.ScrolledWindow(child=self.crumbs, vscrollbar_policy=Gtk.PolicyType.NEVER,
                                hscrollbar_policy=Gtk.PolicyType.EXTERNAL, propagate_natural_width=True)
        self.add_named(sc, "crumbs")
        self.entry = Gtk.Entry(hexpand=True, width_chars=40, placeholder_text="Type a path, e.g. ~/Home/Projects")
        self.entry.connect("activate", self._go)
        esc = Gtk.EventControllerKey()
        esc.connect("key-pressed", lambda c, k, *_: (self.show_crumbs(), True)[1] if k == Gdk.KEY_Escape else False)
        self.entry.add_controller(esc)
        self.add_named(self.entry, "entry")

    def set_location(self, f):
        while (c := self.crumbs.get_first_child()) is not None:
            self.crumbs.remove(c)
        parts = []
        cur = f
        # crumbs start at ~/Home (Orbit layout) or $HOME, whichever contains f
        home = Gio.File.new_for_path(str(paths.orbit_home()))
        if not (f.equal(home) or f.has_prefix(home)):
            home = Gio.File.new_for_path(str(paths.HOME))
        while cur is not None:
            parts.insert(0, cur)
            if cur.equal(home):
                break
            cur = cur.get_parent()
        for p in parts:
            if p.equal(home):
                label = "Home"
            elif p.get_uri_scheme() == "trash":
                label = "Trash"
            else:
                label = p.get_basename() if p.get_parent() else "Computer"
            b = Gtk.Button(label=label)
            b.connect("clicked", lambda _b, loc=p: self.win.current().open(loc))
            self.crumbs.append(b)
        if parts:
            self.crumbs.get_last_child().add_css_class("suggested-action")
        self.entry.set_text(f.get_path() or f.get_uri())
        self.show_crumbs()

    def show_entry(self):
        self.set_visible_child_name("entry")
        self.entry.grab_focus()
        self.entry.select_region(0, -1)

    def show_crumbs(self):
        self.set_visible_child_name("crumbs")

    def _go(self, entry):
        text = os.path.expanduser(entry.get_text().strip())
        f = Gio.File.new_for_commandline_arg(text)
        if f.query_file_type(Gio.FileQueryInfoFlags.NONE, None) == Gio.FileType.DIRECTORY:
            self.win.current().open(f)
        elif f.query_exists(None):
            self.win.launch(f)
        else:
            ui.toast(self.win, f"“{text}” does not exist")
        self.show_crumbs()


# ---------------------------------------------------------------- window
class FilesWindow(Adw.ApplicationWindow):
    def __init__(self, app, location=None):
        super().__init__(application=app, title="Files", default_width=1180, default_height=740)
        self.set_size_request(360, 360)
        self._toasts = Adw.ToastOverlay()
        self.ops = []

        self.sidebar = Sidebar(self)
        self.tabs = Adw.TabView()
        self.tabs.connect("notify::selected-page", lambda *_: self._sync())
        self.tabs.connect("close-page", self._on_close_page)
        tabbar = Adw.TabBar(view=self.tabs, autohide=True)

        self.path = PathBar(self)
        header = Adw.HeaderBar(title_widget=self.path)
        self.side_toggle = Gtk.ToggleButton(icon_name="sidebar-show-symbolic", active=True,
                                            tooltip_text="Sidebar (F9)")
        header.pack_start(self.side_toggle)
        self.btn_back = Gtk.Button(icon_name="go-previous-symbolic", tooltip_text="Back (Alt+←)",
                                   action_name="win.back")
        self.btn_fwd = Gtk.Button(icon_name="go-next-symbolic", tooltip_text="Forward (Alt+→)",
                                  action_name="win.forward")
        header.pack_start(self.btn_back)
        header.pack_start(self.btn_fwd)
        menu = Gio.Menu()
        s1 = Gio.Menu()
        s1.append("New Folder", "win.new-folder")
        s1.append("New Document", "win.new-document")
        s1.append("New Tab", "win.new-tab")
        s1.append("New Window", "win.new-window")
        menu.append_section(None, s1)
        s2 = Gio.Menu()
        s2.append("Show Hidden Files", "win.show-hidden")
        s2.append("Show Preview", "win.show-preview")
        sortm = Gio.Menu()
        for lbl, key in (("Name", "name"), ("Size", "size"), ("Modified", "modified"), ("Kind", "kind")):
            sortm.append(lbl, f"win.sort::{key}")
        sortm.append("Reverse Order", "win.sort-desc")
        s2.append_submenu("Sort By", sortm)
        menu.append_section(None, s2)
        s3 = Gio.Menu()
        s3.append("Open Terminal Here", "win.terminal")
        s3.append("Sort Inbox Now", "win.sort-inbox")
        s3.append("Keyboard Shortcuts", "win.shortcuts")
        s3.append("About Orbit Files", "win.about")
        menu.append_section(None, s3)
        header.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu, tooltip_text="Menu"))
        self.view_toggle = Gtk.Button(icon_name="view-list-symbolic", tooltip_text="List view (Ctrl+2)")
        self.view_toggle.connect("clicked", lambda *_: self.toggle_view())
        header.pack_end(self.view_toggle)
        self.search_btn = Gtk.ToggleButton(icon_name="system-search-symbolic", tooltip_text="Search (Ctrl+F)")
        header.pack_end(self.search_btn)

        self.search_entry = Gtk.SearchEntry(hexpand=True, placeholder_text="Filter this folder…")
        self.search_entry.connect("search-changed", self._on_search_changed)
        self.search_entry.connect("activate", lambda *_: self.deep_search())
        deep = Gtk.Button(label="Search Everywhere", tooltip_text="Search all subfolders (Enter)")
        deep.connect("clicked", lambda *_: self.deep_search())
        sbox = Gtk.Box(spacing=6)
        sbox.append(self.search_entry)
        sbox.append(deep)
        clamp = Adw.Clamp(child=sbox, maximum_size=640)
        self.searchbar = Gtk.SearchBar(child=clamp, show_close_button=False)
        self.searchbar.connect_entry(self.search_entry)
        self.search_btn.bind_property("active", self.searchbar, "search-mode-enabled",
                                      GObject.BindingFlags.BIDIRECTIONAL)
        self.searchbar.connect("notify::search-mode-enabled", self._on_search_mode)

        # ops bar
        self.ops_label = Gtk.Label(xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.END)
        self.ops_detail = Gtk.Label(xalign=0, css_classes=["caption", "dim-label"])
        self.ops_bar = Gtk.ProgressBar(hexpand=True)
        cancel = Gtk.Button(icon_name="process-stop-symbolic", css_classes=["flat", "circular"],
                            tooltip_text="Cancel")
        cancel.connect("clicked", lambda *_: [o.cancel() for o in self.ops])
        obox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, margin_start=12, margin_end=12,
                       margin_top=8, margin_bottom=8)
        row1 = Gtk.Box(spacing=8)
        row1.append(self.ops_label)
        row1.append(cancel)
        obox.append(row1)
        obox.append(self.ops_bar)
        obox.append(self.ops_detail)
        self.ops_revealer = Gtk.Revealer(child=obox, transition_type=Gtk.RevealerTransitionType.SLIDE_UP)

        self.preview = Preview()
        self.preview_revealer = Gtk.Revealer(child=Gtk.ScrolledWindow(child=self.preview,
                                                                      hscrollbar_policy=Gtk.PolicyType.NEVER),
                                             transition_type=Gtk.RevealerTransitionType.SLIDE_LEFT)
        body = Gtk.Box()
        tabs_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, hexpand=True)
        tabs_box.append(tabbar)
        tabs_box.append(self.tabs)
        body.append(tabs_box)
        body.append(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL))
        body.append(self.preview_revealer)

        content = Adw.ToolbarView()
        content.add_top_bar(header)
        content.add_top_bar(self.searchbar)
        content.set_content(body)
        content.add_bottom_bar(self.ops_revealer)

        side_view = Adw.ToolbarView()
        side_header = Adw.HeaderBar(show_title=False)
        side_header.pack_start(Gtk.Label(label="Files", css_classes=["heading"], margin_start=6))
        side_view.add_top_bar(side_header)
        side_view.set_content(self.sidebar)
        self.split = Adw.OverlaySplitView(sidebar=side_view, content=content, min_sidebar_width=210,
                                          max_sidebar_width=260)
        self.side_toggle.bind_property("active", self.split, "show-sidebar", GObject.BindingFlags.BIDIRECTIONAL)
        bp = Adw.Breakpoint.new(Adw.BreakpointCondition.parse("max-width: 720sp"))
        bp.add_setter(self.split, "collapsed", True)
        self.add_breakpoint(bp)

        self._toasts.set_child(self.split)
        self.set_content(self._toasts)
        self._install_actions()
        self.new_tab(location or Gio.File.new_for_path(str(paths.orbit_home())))

    # ---- tabs
    def current(self):
        page = self.tabs.get_selected_page()
        return page.get_child() if page else None

    def new_tab(self, location):
        view = FolderView(self, location)
        page = self.tabs.append(view)
        view.connect("location-changed", lambda v: self._sync(v, page))
        view.connect("selection-changed", lambda v: self._update_preview(v))
        self.tabs.set_selected_page(page)
        self._sync(view, page)
        return view

    def _on_close_page(self, tabs, page):
        if tabs.get_n_pages() == 1:
            self.close()
            return Gdk.EVENT_STOP
        tabs.close_page_finish(page, True)
        return Gdk.EVENT_STOP

    def _sync(self, view=None, page=None):
        view = view or self.current()
        if view is None:
            return
        page = page or self.tabs.get_page(view)
        loc = view.location
        name = "Trash" if loc.get_uri_scheme() == "trash" else (
            "Home" if loc.get_path() in (str(paths.HOME), str(paths.orbit_home())) else (loc.get_basename() or "Computer"))
        page.set_title(name)
        page.set_icon(Gio.ThemedIcon.new("user-trash-symbolic" if loc.get_uri_scheme() == "trash"
                                         else "folder-symbolic"))
        if view is not self.current():
            return
        self.set_title(f"{name} — Files")
        self.path.set_location(loc)
        self.sidebar.sync(loc)
        self.lookup_action("back").set_enabled(bool(view.back))
        self.lookup_action("forward").set_enabled(bool(view.fwd))
        in_trash = loc.get_uri_scheme() == "trash"
        self.lookup_action("empty-trash").set_enabled(in_trash)
        self.view_toggle.set_icon_name("view-grid-symbolic" if view.view_mode == "list" else "view-list-symbolic")
        self.search_entry.set_text(view.filter_text)
        self._update_preview(view)

    def _update_preview(self, view):
        if view is self.current() and self.preview_revealer.get_reveal_child():
            self.preview.show(view.selected_infos())

    # ---- search
    def _on_search_changed(self, entry):
        v = self.current()
        if v.search_results is not None:
            return
        v.filter_text = entry.get_text().lower().strip()
        v.refilter()

    def _on_search_mode(self, bar, _p):
        if not bar.get_search_mode():
            v = self.current()
            if v.search_results is not None:
                v.open(v.location, record=False)
            v.filter_text = ""
            v.refilter()

    def deep_search(self):
        q = self.search_entry.get_text().strip()
        v = self.current()
        if not q or not v.location.get_path():
            return
        root = v.location.get_path()
        ui.toast(self, f"Searching “{q}” in {pathlib.Path(root).name}…", 1)
        ui.run_async(lambda: fileops.search(root, q, show_hidden=v.show_hidden),
                     lambda res: v.show_search_results([Gio.File.new_for_path(str(p)) for p in res]))

    # ---- actions
    def _install_actions(self):
        A = {
            "back": lambda *_: self.current().go_back(),
            "forward": lambda *_: self.current().go_forward(),
            "up": lambda *_: self.current().go_up(),
            "home": lambda *_: self.current().open(Gio.File.new_for_path(str(paths.orbit_home()))),
            "reload": lambda *_: self.current().reload(),
            "new-tab": lambda *_: self.new_tab(self.current().location),
            "close-tab": lambda *_: self.tabs.close_page(self.tabs.get_selected_page()),
            "new-window": lambda *_: FilesWindow(self.get_application(), self.current().location).present(),
            "location": lambda *_: self.path.show_entry(),
            "search": lambda *_: self.search_btn.set_active(not self.search_btn.get_active()),
            "sidebar": lambda *_: self.side_toggle.set_active(not self.side_toggle.get_active()),
            "view-grid": lambda *_: self.set_view("grid"),
            "view-list": lambda *_: self.set_view("list"),
            "open": lambda *_: self.open_selected(),
            "open-with": lambda *_: self.open_selected(ask=True),
            "copy": lambda *_: self.clip(False),
            "cut": lambda *_: self.clip(True),
            "paste": lambda *_: self.paste(),
            "rename": lambda *_: self.rename(),
            "trash": lambda *_: self.trash_files(self.current().selected_files()),
            "delete": lambda *_: self.delete_permanently(),
            "restore": lambda *_: self.restore(),
            "empty-trash": lambda *_: self.empty_trash(),
            "new-folder": lambda *_: self.new_item(folder=True),
            "new-document": lambda *_: self.new_item(folder=False),
            "select-all": lambda *_: self.current().selection.select_all(),
            "properties": lambda *_: self.properties(),
            "copy-path": lambda *_: self.copy_path(),
            "compress": lambda *_: self.compress(),
            "extract": lambda *_: self.extract(),
            "terminal": lambda *_: self.terminal(),
            "share": lambda *_: [ui.spawn(["orbit-sharing", f.get_path()])
                                 for f in self.current().selected_files()[:1] if f.get_path()],
            "sort-inbox": lambda *_: self.sort_inbox(),
            "about": lambda *_: ui.about(self, "Orbit Files", "orbit-files",
                                         "Browse, organise and find your files."),
            "shortcuts": lambda *_: self.shortcuts(),
        }
        for name, cb in A.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", cb)
            self.add_action(a)
        for name, ptype, cb in (("open-tab", "s", lambda a, v: self.new_tab(Gio.File.new_for_uri(v.get_string()))),
                                ("move-to-space", "s", lambda a, v: self.move_to_space(v.get_string())),
                                ("switch-space", "s", lambda a, v: self.switch_space(v.get_string()))):
            a = Gio.SimpleAction.new(name, GLib.VariantType.new(ptype))
            a.connect("activate", cb)
            self.add_action(a)
        hidden = Gio.SimpleAction.new_stateful("show-hidden", None, GLib.Variant.new_boolean(False))
        hidden.connect("change-state", self._on_hidden)
        self.add_action(hidden)
        prev = Gio.SimpleAction.new_stateful("show-preview", None, GLib.Variant.new_boolean(False))
        prev.connect("change-state", self._on_preview)
        self.add_action(prev)
        sort = Gio.SimpleAction.new_stateful("sort", GLib.VariantType.new("s"), GLib.Variant.new_string("name"))
        sort.connect("change-state", self._on_sort)
        self.add_action(sort)
        desc = Gio.SimpleAction.new_stateful("sort-desc", None, GLib.Variant.new_boolean(False))
        desc.connect("change-state", self._on_sort_desc)
        self.add_action(desc)

    def _on_hidden(self, a, v):
        a.set_state(v)
        for i in range(self.tabs.get_n_pages()):
            view = self.tabs.get_nth_page(i).get_child()
            view.show_hidden = v.get_boolean()
            view.refilter()

    def _on_preview(self, a, v):
        a.set_state(v)
        self.preview_revealer.set_reveal_child(v.get_boolean())
        self._update_preview(self.current())

    def _on_sort(self, a, v):
        a.set_state(v)
        self.current().sort_key = v.get_string()
        self.current().resort()

    def _on_sort_desc(self, a, v):
        a.set_state(v)
        self.current().sort_desc = v.get_boolean()
        self.current().resort()

    def set_view(self, mode):
        self.current().set_view(mode)
        self._sync()

    def toggle_view(self):
        self.set_view("list" if self.current().view_mode == "grid" else "grid")

    # ---- menus
    def _popup(self, menu, parent, x, y):
        pop = Gtk.PopoverMenu(menu_model=menu, has_arrow=False, halign=Gtk.Align.START)
        pop.set_parent(parent)
        pop.set_pointing_to(Gdk.Rectangle(int(x), int(y), 1, 1))
        pop.connect("closed", lambda p: GLib.idle_add(p.unparent))
        pop.popup()

    def show_item_menu(self, widget, x, y):
        v = self.current()
        infos = v.selected_infos()
        in_trash = v.location.get_uri_scheme() == "trash"
        m = Gio.Menu()
        if in_trash:
            s = Gio.Menu()
            s.append("Restore", "win.restore")
            s.append("Delete Permanently", "win.delete")
            m.append_section(None, s)
            self._popup(m, widget, x, y)
            return
        s = Gio.Menu()
        s.append("Open", "win.open")
        if len(infos) == 1 and not is_dir(infos[0]):
            s.append("Open With…", "win.open-with")
        if len(infos) == 1 and is_dir(infos[0]):
            s.append("Open in New Tab", f"win.open-tab::{info_file(infos[0]).get_uri()}")
        m.append_section(None, s)
        s = Gio.Menu()
        s.append("Cut", "win.cut")
        s.append("Copy", "win.copy")
        s.append("Copy Path", "win.copy-path")
        if len(infos) == 1:
            s.append("Rename…", "win.rename")
        m.append_section(None, s)
        s = Gio.Menu()
        sp = Gio.Menu()
        for space in spaces.load()[0]:
            sp.append(space["name"], f"win.move-to-space::{space['name']}")
        s.append_submenu("Move to Space", sp)
        s.append("Compress to ZIP", "win.compress")
        if len(infos) == 1 and infos[0].get_name().lower().endswith(ARCHIVE_SUFFIXES):
            s.append("Extract Here", "win.extract")
        if len(infos) == 1 and infos[0].get_file_type() == Gio.FileType.DIRECTORY:
            s.append("Share with Windows PCs…", "win.share")
        m.append_section(None, s)
        s = Gio.Menu()
        s.append("Move to Trash", "win.trash")
        s.append("Properties", "win.properties")
        m.append_section(None, s)
        self._popup(m, widget, x, y)

    def show_background_menu(self, widget, x, y):
        in_trash = self.current().location.get_uri_scheme() == "trash"
        m = Gio.Menu()
        s = Gio.Menu()
        if in_trash:
            s.append("Empty Trash", "win.empty-trash")
        else:
            s.append("New Folder", "win.new-folder")
            s.append("New Document", "win.new-document")
            s.append("Paste", "win.paste")
        m.append_section(None, s)
        s = Gio.Menu()
        s.append("Select All", "win.select-all")
        if not in_trash:
            s.append("Open Terminal Here", "win.terminal")
            if pathlib.Path(self.current().location.get_path() or "/x") == paths.orbit_home() / "Inbox":
                s.append("Sort Inbox Now", "win.sort-inbox")
        m.append_section(None, s)
        self._popup(m, widget, x, y)

    # ---- file actions
    def launch(self, f, ask=False):
        launcher = Gtk.FileLauncher.new(f)
        launcher.set_always_ask(ask)

        def done(l, res):
            try:
                l.launch_finish(res)
            except GLib.Error as e:
                if not e.matches(Gtk.dialog_error_quark(), Gtk.DialogError.DISMISSED):
                    ui.toast(self, f"Couldn’t open “{f.get_basename()}”: {e.message}")
        launcher.launch(self, None, done)

    def open_selected(self, ask=False):
        infos = self.current().selected_infos()
        for info in infos:
            if is_dir(info):
                if len(infos) == 1:
                    self.current().open(info_file(info))
                else:
                    self.new_tab(info_file(info))
            else:
                self.launch(info_file(info), ask)

    def clip(self, cut):
        files = self.current().selected_files()
        if files:
            CLIPBOARD.set(self, files, cut)
            ui.toast(self, f"{'Cut' if cut else 'Copied'} {len(files)} item{'s' if len(files) != 1 else ''}", 1)

    def paste(self):
        dest = self.current().location

        def got(files, cut):
            if not files:
                ui.toast(self, "Nothing to paste")
                return
            self.transfer(files, dest, move=cut)
            if cut:
                CLIPBOARD.files, CLIPBOARD.cut = [], False
        CLIPBOARD.read(self, got)

    def drop_files(self, files, dest, target):
        if not files or dest is None or not dest.get_path():
            return False
        # Shift forces move; same filesystem defaults to move, otherwise copy (like other file managers)
        try:
            same_fs = os.stat(files[0].get_path()).st_dev == os.stat(dest.get_path()).st_dev
        except (OSError, TypeError):
            same_fs = False
        move = same_fs and not (target.get_current_drop() and
                                target.get_current_drop().get_actions() == Gdk.DragAction.COPY)
        self.transfer(files, dest, move=move)
        return True

    def transfer(self, files, dest, move):
        try:
            op = transfer_op(files, dest.get_path(), move)
        except ValueError as e:
            ui.toast(self, str(e))
            return
        if op:
            self.run_op(op)

    def run_op(self, op):
        self.ops.append(op)
        self.ops_label.set_label(op.title)
        self.ops_bar.set_fraction(0)
        self.ops_detail.set_label("")
        self.ops_revealer.set_reveal_child(True)
        op.connect("progress", lambda o, f, t: (self.ops_bar.set_fraction(f), self.ops_detail.set_label(t)))

        def finished(o, ok, msg):
            self.ops.remove(o)
            if not self.ops:
                self.ops_revealer.set_reveal_child(False)
            ui.toast(self, msg if ok else f"Failed: {msg}" if msg != "Cancelled" else "Cancelled")
        op.connect("finished", finished)
        op.start()

    def trash_files(self, files):
        if not files:
            return False
        done = []
        for f in files:
            try:
                f.trash(None)
                done.append(f)
            except GLib.Error as e:
                if e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_SUPPORTED):
                    ui.confirm(self, "This location has no trash",
                               f"Delete “{f.get_basename()}” permanently? This cannot be undone.",
                               "Delete", lambda ff=f: self._delete([ff]))
                else:
                    ui.toast(self, e.message)
        if done:
            t = Adw.Toast(title=f"Moved {len(done)} item{'s' if len(done) != 1 else ''} to the trash",
                          button_label="Undo", timeout=6)
            t.connect("button-clicked", lambda *_: self._undo_trash(done))
            self._toasts.add_toast(t)
        return True

    def _undo_trash(self, files):
        want = {f.get_path() for f in files}
        trash = Gio.File.new_for_uri(TRASH)
        en = trash.enumerate_children("standard::name,trash::orig-path", Gio.FileQueryInfoFlags.NONE, None)
        for info in en:
            if info.get_attribute_byte_string("trash::orig-path") in want:
                src = trash.get_child(info.get_name())
                src.move(Gio.File.new_for_path(info.get_attribute_byte_string("trash::orig-path")),
                         Gio.FileCopyFlags.NONE, None, None)

    def restore(self):
        for info in self.current().selected_infos():
            orig = info.get_attribute_byte_string("trash::orig-path")
            if not orig:
                continue
            dest = pathlib.Path(orig)
            if dest.exists():
                dest = fileops.unique_name(dest.parent, dest.name)
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                info_file(info).move(Gio.File.new_for_path(str(dest)), Gio.FileCopyFlags.NONE, None, None)
            except GLib.Error as e:
                ui.toast(self, e.message)
        ui.toast(self, "Restored")

    def delete_permanently(self):
        files = self.current().selected_files()
        if files:
            ui.confirm(self, f"Delete {len(files)} item{'s' if len(files) != 1 else ''} permanently?",
                       "They will be gone for good. This cannot be undone.", "Delete",
                       lambda: self._delete(files))

    def _delete(self, files):
        def work(op):
            for i, f in enumerate(files):
                p = f.get_path()
                if p and os.path.isdir(p) and not os.path.islink(p):
                    shutil.rmtree(p)
                else:
                    f.delete(None)
                op.report((i + 1) / len(files), f.get_basename())
            return f"Deleted {len(files)} item{'s' if len(files) != 1 else ''}"
        self.run_op(Operation("Deleting", work))

    def empty_trash(self):
        def go():
            def work(op):
                trash = Gio.File.new_for_uri(TRASH)
                items = list(trash.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, None))
                for i, info in enumerate(items):
                    _delete_recursive(trash.get_child(info.get_name()))
                    op.report((i + 1) / max(1, len(items)), info.get_name())
                return "Trash emptied"
            self.run_op(Operation("Emptying trash", work))
        ui.confirm(self, "Empty the trash?", "All items in the trash will be deleted permanently.",
                   "Empty Trash", go)

    def rename(self):
        infos = self.current().selected_infos()
        if len(infos) != 1:
            return
        info = infos[0]
        f = info_file(info)

        def do(new):
            err = fileops.valid_name(new)
            if err:
                ui.toast(self, err)
                return
            if new == info.get_name():
                return
            try:
                f.set_display_name(new, None)
            except GLib.Error as e:
                ui.toast(self, e.message)
        ui.ask_text(self, "Rename", info.get_display_name(), "Rename", do)

    def new_item(self, folder):
        loc = self.current().location
        if not loc.get_path():
            return

        def do(name):
            err = fileops.valid_name(name)
            if err:
                ui.toast(self, err)
                return
            target = fileops.unique_name(loc.get_path(), name)
            try:
                if folder:
                    target.mkdir()
                else:
                    target.touch()
            except OSError as e:
                ui.toast(self, e.strerror)
        ui.ask_text(self, "New Folder" if folder else "New Document",
                    "New Folder" if folder else "Untitled.txt", "Create", do)

    def copy_path(self):
        paths_ = [f.get_path() or f.get_uri() for f in self.current().selected_files()]
        if paths_:
            self.get_display().get_clipboard().set("\n".join(paths_))
            ui.toast(self, "Path copied", 1)

    def compress(self):
        files = [f for f in self.current().selected_files() if f.get_path()]
        if files:
            self.run_op(compress_op(files, self.current().location.get_path()))

    def extract(self):
        files = self.current().selected_files()
        if len(files) == 1 and files[0].get_path():
            self.run_op(extract_op(files[0], self.current().location.get_path()))

    def terminal(self):
        p = self.current().location.get_path()
        if p:
            for argv in (["gnome-terminal", f"--working-directory={p}"], ["kgx", f"--working-directory={p}"],
                         ["x-terminal-emulator"]):
                if shutil.which(argv[0]) and ui.spawn(argv):
                    return
            ui.toast(self, "No terminal app found")

    def sort_inbox(self):
        sorter = "/usr/lib/orbit-os/orbit-inbox-sorter"
        if not os.path.exists(sorter):
            ui.toast(self, "The Inbox sorter is not installed")
            return

        def run():
            before = len(list((paths.orbit_home() / "Inbox").glob("*")))
            subprocess.run([sorter], check=False)
            after = len(list((paths.orbit_home() / "Inbox").glob("*")))
            return before - after
        ui.run_async(run, lambda n: ui.toast(self, f"Sorted {n} file{'s' if n != 1 else ''} out of Inbox"
                                             if n else "Nothing to sort (files newer than 10 s wait)"))

    def move_to_space(self, name):
        sp = [s for s in spaces.load()[0] if s["name"] == name]
        if not sp:
            return
        dest = spaces.folder(sp[0])
        dest.mkdir(parents=True, exist_ok=True)
        self.transfer(self.current().selected_files(), Gio.File.new_for_path(str(dest)), move=True)

    def switch_space(self, name):
        try:
            spaces.switch(name)
            ui.toast(self, f"Switched to {name}")
            self.sidebar.rebuild()
        except KeyError as e:
            ui.toast(self, str(e))

    def eject(self, mount):
        op = Gio.MountOperation()

        def done(m, res):
            try:
                (m.eject_with_operation_finish if m.can_eject() else m.unmount_with_operation_finish)(res)
                ui.toast(self, f"“{m.get_name()}” can be removed safely")
            except GLib.Error as e:
                ui.toast(self, e.message)
        if mount.can_eject():
            mount.eject_with_operation(Gio.MountUnmountFlags.NONE, op, None, done)
        else:
            mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, op, None, done)

    def properties(self):
        infos = self.current().selected_infos()
        if not infos:
            infos = [self.current().location.query_info(ATTRS, Gio.FileQueryInfoFlags.NONE, None)]
            infos[0].set_attribute_object("standard::file", self.current().location)
        PropertiesDialog(infos).present(self)

    def shortcuts(self):
        d = Adw.Dialog(title="Keyboard Shortcuts", content_width=420)
        page = Adw.PreferencesPage()
        for title, rows in SHORTCUT_HELP:
            g = Adw.PreferencesGroup(title=title)
            for keys, what in rows:
                r = Adw.ActionRow(title=what)
                r.add_suffix(Gtk.Label(label=keys, css_classes=["dim-label", "orbit-mono"]))
                g.add(r)
            page.add(g)
        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(Adw.HeaderBar())
        d.set_child(tv)
        d.present(self)


def _delete_recursive(f):
    try:
        en = f.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, None)
        for info in en:
            child = f.get_child(info.get_name())
            if info.get_file_type() == Gio.FileType.DIRECTORY:
                _delete_recursive(child)
            else:
                child.delete(None)
    except GLib.Error:
        pass
    f.delete(None)


class PropertiesDialog(Adw.Dialog):
    def __init__(self, infos):
        super().__init__(title="Properties", content_width=440)
        page = Adw.PreferencesPage()
        g = Adw.PreferencesGroup()
        page.add(g)
        if len(infos) == 1:
            info = infos[0]
            f = info_file(info)
            g.set_title(info.get_display_name())
            ctype = info.get_content_type() or ""
            self._row(g, "Kind", Gio.content_type_get_description(ctype) if ctype else "")
            self._row(g, "Location", f.get_parent().get_path() if f.get_parent() else "/")
            d = info.get_modification_date_time()
            if d:
                self._row(g, "Modified", d.to_local().format("%A %e %B %Y, %H:%M"))
            mode = info.get_attribute_uint32("unix::mode")
            if mode:
                self._row(g, "Permissions", fileops.permissions_text(mode))
            size_row = self._row(g, "Size", "calculating…" if is_dir(info) else
                                 f"{ui.human_size(info.get_size())} ({info.get_size():,} bytes)")
            if is_dir(info) and f.get_path():
                ui.run_async(lambda: fileops.total_bytes([f.get_path()]),
                             lambda n: size_row.set_subtitle(f"{ui.human_size(n)} ({n:,} bytes)"))
            if not is_dir(info) and ctype:
                app = Gio.AppInfo.get_default_for_type(ctype, False)
                self._row(g, "Opens with", app.get_display_name() if app else "No app set")
        else:
            g.set_title(f"{len(infos)} items")
            paths_ = [info_file(i).get_path() for i in infos if info_file(i).get_path()]
            size_row = self._row(g, "Total size", "calculating…")
            ui.run_async(lambda: fileops.total_bytes(paths_), lambda n: size_row.set_subtitle(ui.human_size(n)))
        tv = Adw.ToolbarView(content=page)
        tv.add_top_bar(Adw.HeaderBar())
        self.set_child(tv)

    @staticmethod
    def _row(group, k, v):
        r = Adw.ActionRow(title=k, subtitle=v or "—", subtitle_selectable=True)
        r.add_css_class("property")
        group.add(r)
        return r


SHORTCUT_HELP = [
    ("Navigation", [("Alt+←", "Back"), ("Alt+→", "Forward"), ("Alt+↑", "Parent folder"), ("Alt+Home", "Home"),
                    ("Ctrl+L", "Type a location"), ("Ctrl+F", "Search"), ("F5", "Reload")]),
    ("Tabs and windows", [("Ctrl+T", "New tab"), ("Ctrl+W", "Close tab"), ("Ctrl+N", "New window"),
                          ("F9", "Sidebar"), ("Ctrl+1 / Ctrl+2", "Grid / list view"), ("Space", "Preview")]),
    ("Files", [("Ctrl+C / X / V", "Copy / cut / paste"), ("F2", "Rename"), ("Delete", "Move to trash"),
               ("Shift+Delete", "Delete permanently"), ("Ctrl+Shift+N", "New folder"), ("Ctrl+A", "Select all"),
               ("Ctrl+I", "Properties"), ("Ctrl+H", "Show hidden files")]),
]

ACCELS = {
    "win.back": ["<Alt>Left", "BackSpace"], "win.forward": ["<Alt>Right"], "win.up": ["<Alt>Up"],
    "win.home": ["<Alt>Home"], "win.reload": ["F5", "<Ctrl>r"], "win.new-tab": ["<Ctrl>t"],
    "win.close-tab": ["<Ctrl>w"], "win.new-window": ["<Ctrl>n"], "win.location": ["<Ctrl>l"],
    "win.search": ["<Ctrl>f"], "win.sidebar": ["F9"], "win.view-grid": ["<Ctrl>1"], "win.view-list": ["<Ctrl>2"],
    "win.copy": ["<Ctrl>c"], "win.cut": ["<Ctrl>x"], "win.paste": ["<Ctrl>v"], "win.rename": ["F2"],
    "win.trash": ["Delete"], "win.delete": ["<Shift>Delete"], "win.new-folder": ["<Ctrl><Shift>n"],
    "win.select-all": ["<Ctrl>a"], "win.properties": ["<Ctrl>i", "<Alt>Return"], "win.show-hidden": ["<Ctrl>h"],
    "win.show-preview": ["space"], "win.shortcuts": ["<Ctrl>question"],
}


class FilesApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Files", lambda app: FilesWindow(app),
                         Gio.ApplicationFlags.HANDLES_OPEN)
        self.connect("open", self._on_open)
        self.connect("startup", lambda *_: ui.add_shortcuts(self, ACCELS))

    def _on_open(self, app, files, n, hint):
        for f in files:
            if f.query_file_type(Gio.FileQueryInfoFlags.NONE, None) == Gio.FileType.DIRECTORY:
                FilesWindow(self, f).present()
            else:
                w = FilesWindow(self, f.get_parent())
                w.present()


def main():
    return FilesApp().run_main()
