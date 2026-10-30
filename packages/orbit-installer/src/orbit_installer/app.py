"""Orbit Installer: the window you click through. Runs as the live user and never touches
a disk itself; every disk action goes to the root engine (engine.py) through pkexec."""
import json
import os
import re
import subprocess
import sys
import threading

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, GLib, Gtk  # noqa: E402

from . import data  # noqa: E402
from .target import Settings, validate  # noqa: E402

sys.path.insert(0, "/usr/lib/orbit-os/python")
try:
    from orbit.ui import OrbitApp  # shared Orbit look (theme tokens, dark/light)
except ImportError:  # running from the source tree without orbit-apps
    OrbitApp = None

ENGINE = os.environ.get("ORBIT_INSTALLER_ENGINE", "/usr/lib/orbit-installer/orbit-install-engine")
GiB = 1024 ** 3

CSS = """
.oi-side { background: alpha(currentColor, .04); padding: 28px 18px; }
.oi-step { padding: 8px 12px; border-radius: 10px; opacity: .55; }
.oi-step.current { opacity: 1; background: alpha(currentColor, .08); font-weight: 600; }
.oi-step.done { opacity: .85; }
.oi-title { font-size: 26px; font-weight: 700; }
.oi-lead { font-size: 15px; opacity: .75; }
.oi-card { border-radius: 14px; padding: 16px 18px; background: alpha(currentColor, .05); border: 1px solid alpha(currentColor, .08); }
.oi-card:checked, .oi-card.selected { background: alpha(@accent_bg_color, .18); border-color: @accent_bg_color; }
.oi-card.disabled { opacity: .5; }
.oi-warn { color: #e8b75c; }
.oi-error { color: #ef6b73; }
.oi-big { font-size: 40px; font-weight: 300; }
.oi-bar trough { min-height: 10px; border-radius: 999px; }
.oi-bar progress { min-height: 10px; border-radius: 999px; }
.oi-split { border-radius: 10px; min-height: 26px; }
.oi-win { background: #3d7fd6; border-radius: 10px 0 0 10px; }
.oi-orbit { background: #9b6cf0; border-radius: 0 10px 10px 0; }
"""

STEPS = ["Welcome", "Keyboard", "Disk", "Account", "Time zone", "Review", "Install"]

SLIDES = [
    ("Glass, everywhere", "A calm desktop with frosted panels, your own colours and four styles to pick from."),
    ("Your Home, organised", "Inbox, Projects, Spaces and the usual folders are ready, with Orbit Files to find anything fast."),
    ("Aphelion browser", "Tracker shield, ad blocker, KeePass, 2FA codes and reader view, built in, nothing sent anywhere."),
    ("Apps when you want them", "Orbit Store brings hand-picked apps from Debian and Flathub. No account needed."),
    ("Private by default", "No telemetry, no crash reports sent, firewall on, security updates install themselves."),
]


class EngineClient:
    """The root engine as a child process; events arrive on the GTK main loop."""

    def __init__(self, on_event):
        self.on_event = on_event
        self.proc = None

    def start(self):
        argv = [ENGINE] if os.geteuid() == 0 else ["pkexec", ENGINE]
        if os.environ.get("ORBIT_INSTALLER_DRY"):
            argv = [sys.executable, "-m", "orbit_installer.engine", "--dry-run"]
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            GLib.idle_add(self.on_event, ev)
        GLib.idle_add(self.on_event, {"event": "exited", "code": self.proc.wait()})

    def send(self, **msg):
        if not self.proc:
            self.start()
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()


def human(n):
    return f"{n / GiB:.0f} GB" if n >= 10 * GiB else f"{n / GiB:.1f} GB"


class Window(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Install Orbit OS", default_width=1060, default_height=720)
        css = Gtk.CssProvider()
        css.load_from_string(CSS)
        Gtk.StyleContext.add_provider_for_display(self.get_display(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)
        self.engine = EngineClient(self.on_event)
        self.probe = None
        self.choice = {}
        self.plan = None
        self.lang = data.LANGUAGES[0]
        self.kbd = ("us", "")
        self.zone = self.lang[4]
        self.step = 0
        self.slide = 0

        root = Gtk.Box()
        self.set_content(root)
        # left: steps
        side = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, width_request=220)
        side.add_css_class("oi-side")
        logo = Gtk.Image(icon_name="orbit-launcher", pixel_size=40, halign=Gtk.Align.START, margin_bottom=18)
        side.append(logo)
        side.append(Gtk.Label(label="Orbit OS", xalign=0, css_classes=["title-3"], margin_bottom=18))
        self.step_labels = []
        for name in STEPS:
            lab = Gtk.Label(label=name, xalign=0, css_classes=["oi-step"])
            self.step_labels.append(lab)
            side.append(lab)
        root.append(side)
        # right: page + buttons
        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, hexpand=True)
        header = Adw.HeaderBar(show_title=False)
        right.append(header)
        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.SLIDE_LEFT_RIGHT, vexpand=True, hexpand=True)
        right.append(self.stack)
        bar = Gtk.Box(spacing=10, margin_start=40, margin_end=40, margin_bottom=28, margin_top=10)
        self.back = Gtk.Button(label="Back")
        self.back.connect("clicked", lambda *_: self.go(self.step - 1))
        self.status = Gtk.Label(hexpand=True, xalign=1, wrap=True, css_classes=["oi-error"])
        self.next = Gtk.Button(label="Continue", css_classes=["suggested-action", "pill"])
        self.next.connect("clicked", lambda *_: self.forward())
        bar.append(self.back)
        bar.append(self.status)
        bar.append(self.next)
        right.append(bar)
        self.bar = bar
        root.append(right)

        self.pages = [self.page_welcome(), self.page_keyboard(), self.page_disk(), self.page_account(),
                      self.page_zone(), self.page_review(), self.page_progress()]
        for i, p in enumerate(self.pages):
            self.stack.add_named(p, str(i))
        self.stack.add_named(self.page_done(), "done")
        self.stack.add_named(self.page_failed(), "failed")
        self.go(0)

    # ------------------------------------------------------------------ helpers
    def page(self, title, lead):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16, margin_start=48, margin_end=48, margin_top=8)
        box.append(Gtk.Label(label=title, xalign=0, css_classes=["oi-title"]))
        if lead:
            box.append(Gtk.Label(label=lead, xalign=0, wrap=True, css_classes=["oi-lead"]))
        return box

    def go(self, i):
        i = max(0, min(i, len(STEPS) - 1))
        self.step = i
        self.status.set_text("")
        self.stack.set_visible_child_name(str(i))
        for n, lab in enumerate(self.step_labels):
            for c in ("current", "done"):
                lab.remove_css_class(c)
            lab.add_css_class("current" if n == i else "done" if n < i else "x")
        self.back.set_visible(0 < i < 6)
        self.bar.set_visible(i < 6)
        self.next.set_label({0: "Install Orbit OS", 5: "Install now"}.get(i, "Continue"))
        self.next.remove_css_class("destructive-action")
        self.next.add_css_class("suggested-action")
        enter = getattr(self, f"enter_{i}", None)
        if enter:
            enter()

    def forward(self):
        check = getattr(self, f"leave_{self.step}", None)
        problem = check() if check else ""
        if problem:
            self.status.set_text(problem)
            return
        if self.step == 5:
            self.start_install()
            return
        self.go(self.step + 1)

    def searchable_list(self, rows, on_pick, selected=None, height=360):
        """A search entry over a list of (key, title, subtitle) rows."""
        search = Gtk.SearchEntry(placeholder_text="Search")
        lb = Gtk.ListBox(selection_mode=Gtk.SelectionMode.SINGLE, css_classes=["boxed-list"])
        items = []
        for key, title, sub in rows:
            r = Adw.ActionRow(title=GLib.markup_escape_text(title), subtitle=GLib.markup_escape_text(sub or ""))
            r.key = key
            r.text = f"{title} {sub} {key}".lower()
            lb.append(r)
            items.append(r)
            if key == selected:
                lb.select_row(r)
        lb.set_filter_func(lambda r: search.get_text().lower() in r.text)
        search.connect("search-changed", lambda *_: lb.invalidate_filter())
        lb.connect("row-selected", lambda _lb, r: r and on_pick(r.key))
        sc = Gtk.ScrolledWindow(min_content_height=height, vexpand=True, child=lb)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        box.append(search)
        box.append(sc)
        sel = lb.get_selected_row()
        if sel:
            GLib.idle_add(lambda: sel.grab_focus() and False)
        return box

    # ------------------------------------------------------------------ 0 welcome
    def page_welcome(self):
        p = self.page("Welcome to Orbit OS", "Pick your language. You can try Orbit from this USB stick first: "
                                            "nothing is changed on your computer until you choose Install now.")
        rows = [(l[0], l[1], l[2] if l[2] != l[1] else "") for l in data.LANGUAGES]
        p.append(self.searchable_list(rows, self.pick_lang, self.lang[0], 300))
        try_btn = Gtk.Button(label="Keep trying Orbit OS", halign=Gtk.Align.START, css_classes=["flat"])
        try_btn.connect("clicked", lambda *_: self.close())
        p.append(try_btn)
        return p

    def pick_lang(self, key):
        self.lang = next(l for l in data.LANGUAGES if l[0] == key)
        self.kbd = (self.lang[3], "")
        self.zone = self.lang[4]

    # ------------------------------------------------------------------ 1 keyboard
    def page_keyboard(self):
        p = self.page("Keyboard", "Choose your keyboard layout, then type below to check it.")
        self.kbd_holder = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, vexpand=True)
        p.append(self.kbd_holder)
        p.append(Gtk.Entry(placeholder_text="Type here to test your keyboard"))
        return p

    def enter_1(self):
        child = self.kbd_holder.get_first_child()
        if child:
            self.kbd_holder.remove(child)
        rows = [(f"{lay}+{var}" if var else lay, desc, f"{lay} {var}".strip()) for lay, var, desc in data.layouts()]
        sel = f"{self.kbd[0]}+{self.kbd[1]}" if self.kbd[1] else self.kbd[0]
        self.kbd_holder.append(self.searchable_list(rows, self.pick_kbd, sel, 320))

    def pick_kbd(self, key):
        lay, _, var = key.partition("+")
        self.kbd = (lay, var)
        # switch the live session too, so the test field uses it
        subprocess.run(["gsettings", "set", "org.gnome.desktop.input-sources", "sources", f"[('xkb', '{key}')]"],
                       check=False, capture_output=True)

    # ------------------------------------------------------------------ 2 disk
    def page_disk(self):
        p = self.page("Where should Orbit OS go?", "")
        self.disk_lead = p.get_last_child()
        self.disk_area = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, vexpand=True)
        p.append(Gtk.ScrolledWindow(child=self.disk_area, vexpand=True))
        return p

    def enter_2(self):
        if self.probe is None:
            self.fill(self.disk_area, [Gtk.Spinner(spinning=True, halign=Gtk.Align.CENTER, width_request=32, height_request=32),
                                       Gtk.Label(label="Looking at your disks… (your password may be asked once)")])
            self.next.set_sensitive(False)
            self.engine.send(cmd="probe")
            return
        self.draw_disks()

    def fill(self, box, widgets):
        while box.get_first_child():
            box.remove(box.get_first_child())
        for w in widgets:
            box.append(w)

    def draw_disks(self):
        self.next.set_sensitive(True)
        disks = self.probe["disks"]
        if not disks:
            self.fill(self.disk_area, [Gtk.Label(label="No disk was found that Orbit can be installed on (at least 24 GB).",
                                                 css_classes=["oi-error"], wrap=True)])
            self.next.set_sensitive(False)
            return
        if self.choice.get("disk") not in [d["disk"]["path"] for d in disks]:
            self.choice = {"disk": disks[0]["disk"]["path"]}
        widgets = []
        if len(disks) > 1:
            names = [f"{d['disk']['model'] or d['disk']['path']} — {human(d['disk']['size'])} ({d['disk']['path']})" for d in disks]
            dd = Gtk.DropDown.new_from_strings(names)
            dd.set_selected([d["disk"]["path"] for d in disks].index(self.choice["disk"]))
            dd.connect("notify::selected", lambda w, *_: (self.choice.update(disk=disks[w.get_selected()]["disk"]["path"], mode=None),
                                                         self.draw_disks()))
            widgets.append(dd)
        cur = next(d for d in disks if d["disk"]["path"] == self.choice["disk"])
        dk = cur["disk"]
        widgets.append(Gtk.Label(xalign=0, css_classes=["oi-lead"],
                                 label=f"{dk['model'] or dk['path']} · {human(dk['size'])} · "
                                       f"{'UEFI' if self.probe['firmware'] == 'uefi' else 'BIOS'} start-up"))
        opts = {o["id"]: o for o in cur["options"]}
        if not self.choice.get("mode"):
            self.choice["mode"] = "alongside" if opts.get("alongside", {}).get("ok") else "erase"
        group = None
        texts = {
            "alongside": ("Install next to Windows", "Keep Windows and your files. Choose between them when the computer starts."),
            "free": ("Use the free space", "Orbit goes into the unused part of the disk. Nothing else changes."),
            "erase": ("Erase disk and install Orbit OS", "Everything on this disk is deleted: other systems, programs and files."),
        }
        for oid in ("alongside", "free", "erase"):
            o = opts.get(oid)
            if not o:
                continue
            title, body = texts[oid]
            if oid == "free":
                body += f" ({human(o['size'])} free)"
            btn = Gtk.CheckButton(group=group, active=self.choice["mode"] == oid, sensitive=o["ok"])
            group = group or btn
            card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4, css_classes=["oi-card"])
            head = Gtk.Box(spacing=10)
            head.append(btn)
            head.append(Gtk.Label(label=title, xalign=0, css_classes=["heading"]))
            card.append(head)
            card.append(Gtk.Label(label=body, xalign=0, wrap=True, margin_start=32, css_classes=["oi-warn"] if oid == "erase" else []))
            if not o["ok"]:
                card.add_css_class("disabled")
                card.append(Gtk.Label(label=o["why"], xalign=0, wrap=True, margin_start=32, css_classes=["caption"]))
            if self.choice["mode"] == oid:
                card.add_css_class("selected")
            btn.connect("toggled", lambda b, oid=oid: b.get_active() and (self.choice.update(mode=oid), self.draw_disks()))
            widgets.append(card)
            if oid == "alongside" and o["ok"] and self.choice["mode"] == "alongside":
                widgets.append(self.size_picker(dk, o))
        if self.choice["mode"] == "free":
            self.choice["gap"] = opts["free"]["gap"]
        widgets.append(self.encrypt_box())
        self.fill(self.disk_area, widgets)

    def size_picker(self, dk, o):
        win = next(p for p in dk["parts"] if p["number"] == o["windows"])
        lo = 20 * GiB
        hi = max(lo, win["size"] - win["min_size"] - 20 * GiB)
        cur = int(self.choice.get("size") or min(max(lo, (hi + lo) // 2), hi))
        self.choice["size"] = cur
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin_start=32)
        bar = Gtk.Box(css_classes=["oi-split"])
        w_part = Gtk.Box(css_classes=["oi-win"], hexpand=True)
        o_part = Gtk.Box(css_classes=["oi-orbit"], hexpand=True)
        bar.append(w_part)
        bar.append(o_part)
        lab = Gtk.Label(xalign=0)
        scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, lo, hi, GiB)
        scale.set_value(cur)
        scale.set_draw_value(False)

        def update(*_):
            v = int(scale.get_value()) // GiB * GiB
            self.choice["size"] = v
            w = win["size"] - v
            lab.set_label(f"Windows keeps {human(w)}  ·  Orbit OS gets {human(v)}")
            total = win["size"]
            w_part.set_size_request(int(600 * w / total), -1)
            o_part.set_size_request(int(600 * v / total), -1)
        scale.connect("value-changed", update)
        update()
        box.append(bar)
        box.append(scale)
        box.append(lab)
        return box

    def encrypt_box(self):
        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, css_classes=["oi-card"], margin_top=6)
        row = Gtk.Box(spacing=10)
        sw = Gtk.Switch(active=bool(self.choice.get("encrypt")), valign=Gtk.Align.CENTER)
        txt = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, hexpand=True)
        txt.append(Gtk.Label(label="Encrypt Orbit OS", xalign=0, css_classes=["heading"]))
        txt.append(Gtk.Label(label="Protects your files if the computer is lost or stolen. You type a security key every time it starts.",
                             xalign=0, wrap=True, css_classes=["caption"]))
        row.append(txt)
        row.append(sw)
        card.append(row)
        keys = Gtk.Box(spacing=8, visible=sw.get_active())
        self.key1 = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text="Security key (8+ characters)", hexpand=True)
        self.key2 = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text="Repeat security key", hexpand=True)
        keys.append(self.key1)
        keys.append(self.key2)
        card.append(keys)
        card.append(Gtk.Label(label="If you forget this key, nobody can get your files back.", xalign=0,
                              css_classes=["caption", "oi-warn"], visible=sw.get_active()))

        def toggled(*_):
            self.choice["encrypt"] = sw.get_active()
            keys.set_visible(sw.get_active())
            card.get_last_child().set_visible(sw.get_active())
        sw.connect("notify::active", toggled)
        return card

    def leave_2(self):
        if not self.probe:
            return "Still looking at your disks."
        if self.choice.get("encrypt"):
            k1, k2 = self.key1.get_text(), self.key2.get_text()
            if len(k1) < 8:
                return "The security key must be at least 8 characters."
            if k1 != k2:
                return "The two security keys are not the same."
            self.choice["key"] = k1
        else:
            self.choice.pop("key", None)
        return ""

    # ------------------------------------------------------------------ 3 account
    def page_account(self):
        p = self.page("Your account", "This is how you sign in to Orbit OS.")
        grp = Adw.PreferencesGroup()
        self.e_name = Adw.EntryRow(title="Your name")
        self.e_user = Adw.EntryRow(title="Username")
        self.e_host = Adw.EntryRow(title="Computer name")
        self.e_pw1 = Adw.PasswordEntryRow(title="Password")
        self.e_pw2 = Adw.PasswordEntryRow(title="Repeat password")
        self.e_auto = Adw.SwitchRow(title="Sign in automatically", subtitle="Skip the password when the computer starts")
        for w in (self.e_name, self.e_user, self.e_host, self.e_pw1, self.e_pw2, self.e_auto):
            grp.add(w)
        self._user_edited = self._host_edited = False
        self.e_name.connect("changed", self.name_changed)
        # typing in a field yourself stops the automatic suggestion for it
        self.e_user.connect("changed", lambda *_: self.e_user.has_focus() and setattr(self, "_user_edited", True))
        self.e_host.connect("changed", lambda *_: self.e_host.has_focus() and setattr(self, "_host_edited", True))
        p.append(grp)
        return p

    def name_changed(self, *_):
        first = re.sub(r"[^a-z0-9]", "", (self.e_name.get_text().split() or [""])[0].lower())
        if not self._user_edited:
            self.e_user.set_text(first if first[:1].isalpha() else f"u{first}" if first else "")
        if not self._host_edited:
            self.e_host.set_text(f"{first}-orbit" if first else "orbit")

    def settings(self):
        return Settings(fullname=self.e_name.get_text().strip(), username=self.e_user.get_text().strip(),
                        password=self.e_pw1.get_text(), hostname=self.e_host.get_text().strip(),
                        autologin=self.e_auto.get_active(), locale=self.lang[0], keyboard=self.kbd[0],
                        variant=self.kbd[1], timezone=self.zone)

    def leave_3(self):
        if self.e_pw1.get_text() != self.e_pw2.get_text():
            return "The two passwords are not the same."
        problems = validate(self.settings())
        return problems[0] if problems else ""

    # ------------------------------------------------------------------ 4 time zone
    def page_zone(self):
        p = self.page("Time zone", "Used for the clock and the calendar.")
        self.zone_holder = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, vexpand=True)
        p.append(self.zone_holder)
        return p

    def enter_4(self):
        child = self.zone_holder.get_first_child()
        if child:
            self.zone_holder.remove(child)
        rows = [(z, data.nice_zone(z), z) for z in data.timezones()]
        self.zone_holder.append(self.searchable_list(rows, lambda z: setattr(self, "zone", z), self.zone, 380))

    # ------------------------------------------------------------------ 5 review
    def page_review(self):
        p = self.page("Ready to install", "")
        self.review = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        p.append(self.review)
        return p

    def enter_5(self):
        self.plan = None
        self.next.set_sensitive(False)
        self.fill(self.review, [Gtk.Spinner(spinning=True, halign=Gtk.Align.START)])
        self.engine.send(cmd="plan", choice={k: v for k, v in self.choice.items() if k != "key"})

    def draw_review(self):
        s = self.settings()
        items = [Gtk.Label(label=line, xalign=0, wrap=True, css_classes=["oi-lead"]) for line in self.plan["summary"]]
        grp = Adw.PreferencesGroup(margin_top=8)
        for title, val in (("Name", f"{s.fullname} ({s.username})"), ("Computer name", s.hostname),
                           ("Language", self.lang[1]), ("Keyboard", "+".join(x for x in self.kbd if x)),
                           ("Time zone", data.nice_zone(s.timezone)),
                           ("Encryption", "On" if self.plan["encrypted"] else "Off")):
            grp.add(Adw.ActionRow(title=title, subtitle=GLib.markup_escape_text(val)))
        items.append(grp)
        self.confirm_entry = None
        if self.plan["erases"]:
            word = "ERASE"
            items.append(Gtk.Label(label=f"This deletes everything on {self.plan['disk']}. Type {word} to confirm.",
                                   xalign=0, wrap=True, css_classes=["oi-warn", "heading"], margin_top=8))
            self.confirm_entry = Gtk.Entry(placeholder_text=word, max_width_chars=12, halign=Gtk.Align.START)
            self.confirm_entry.connect("changed", lambda e: self.next.set_sensitive(e.get_text().strip() == word))
            items.append(self.confirm_entry)
            self.next.remove_css_class("suggested-action")
            self.next.add_css_class("destructive-action")
            self.next.set_sensitive(False)
        else:
            self.next.set_sensitive(True)
        self.fill(self.review, items)

    # ------------------------------------------------------------------ 6 progress
    def page_progress(self):
        p = self.page("Installing Orbit OS", "")
        p.set_valign(Gtk.Align.CENTER)
        self.slide_title = Gtk.Label(xalign=0, css_classes=["oi-big"], margin_top=40)
        self.slide_body = Gtk.Label(xalign=0, wrap=True, css_classes=["oi-lead"], max_width_chars=60)
        p.append(self.slide_title)
        p.append(self.slide_body)
        self.pbar = Gtk.ProgressBar(css_classes=["oi-bar"], margin_top=60)
        self.pmsg = Gtk.Label(xalign=0, css_classes=["caption"])
        p.append(self.pbar)
        p.append(self.pmsg)
        return p

    def next_slide(self):
        if self.step != 6:
            return False
        t, b = SLIDES[self.slide % len(SLIDES)]
        self.slide_title.set_label(t)
        self.slide_body.set_label(b)
        self.slide += 1
        return True

    def start_install(self):
        self.go(6)
        self.next_slide()
        GLib.timeout_add_seconds(8, self.next_slide)
        s = self.settings()
        self.engine.send(cmd="install", choice=self.choice,
                         settings={"fullname": s.fullname, "username": s.username, "password": s.password,
                                   "hostname": s.hostname, "autologin": s.autologin, "locale": s.locale,
                                   "keyboard": s.keyboard, "variant": s.variant, "timezone": s.timezone})

    # ------------------------------------------------------------------ done / failed
    def page_done(self):
        p = self.page("Orbit OS is installed", "Restart the computer and take out the USB stick when the screen goes dark.")
        p.set_valign(Gtk.Align.CENTER)
        b = Gtk.Box(spacing=10, margin_top=20)
        r = Gtk.Button(label="Restart now", css_classes=["suggested-action", "pill"])
        r.connect("clicked", lambda *_: subprocess.run(["systemctl", "reboot"], check=False))
        k = Gtk.Button(label="Keep trying", css_classes=["pill"])
        k.connect("clicked", lambda *_: self.close())
        b.append(r)
        b.append(k)
        p.append(b)
        return p

    def page_failed(self):
        p = self.page("The installation stopped", "")
        p.set_valign(Gtk.Align.CENTER)
        self.fail_msg = Gtk.Label(xalign=0, wrap=True, selectable=True, css_classes=["oi-error"])
        p.append(self.fail_msg)
        p.append(Gtk.Label(label="The full log is in /var/log/orbit-installer.log. Nothing after this step was changed.",
                           xalign=0, wrap=True, css_classes=["caption"]))
        k = Gtk.Button(label="Close", halign=Gtk.Align.START, css_classes=["pill"], margin_top=16)
        k.connect("clicked", lambda *_: self.close())
        p.append(k)
        return p

    # ------------------------------------------------------------------ engine events
    def on_event(self, ev):
        kind = ev.get("event")
        if kind == "probe":
            self.probe = ev
            if self.step == 2:
                self.draw_disks()
        elif kind == "plan":
            self.plan = ev["plan"]
            if self.step == 5:
                self.draw_review()
        elif kind == "progress":
            self.pbar.set_fraction(ev["percent"] / 100)
            self.pmsg.set_label(ev["say"])
        elif kind == "done":
            self.stack.set_visible_child_name("done")
        elif kind == "error":
            if ev.get("fatal") or self.step == 6:
                self.fail_msg.set_label(ev["message"])
                self.stack.set_visible_child_name("failed")
            else:
                self.status.set_text(ev["message"])
                if self.step == 5:
                    self.fill(self.review, [Gtk.Label(label=ev["message"], wrap=True, xalign=0, css_classes=["oi-error"])])
        elif kind == "exited" and self.step < 6 and self.probe is None:
            self.fill(self.disk_area, [Gtk.Label(label="The installer needs administrator rights to look at your disks, "
                                                       "and they were not given.", wrap=True, css_classes=["oi-error"])])
        return False


def is_live():
    return any(os.path.isdir(p) for p in ("/run/live/medium", "/lib/live/mount/medium"))


def main():
    if "--autostart" in sys.argv:
        sys.argv.remove("--autostart")
        if not is_live():
            return 0   # installed system: the welcome installer never pops up
    if not is_live() and not os.environ.get("ORBIT_INSTALLER_DRY"):
        print("The Orbit installer only runs from the Orbit OS live USB.", file=sys.stderr)
        return 1
    if OrbitApp:
        app = OrbitApp("org.orbitos.Installer", Window)
        return app.run_main()
    app = Adw.Application(application_id="org.orbitos.Installer")
    app.connect("activate", lambda a: Window(a).present())
    return app.run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())
