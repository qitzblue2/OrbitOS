"""Orbit Assistant — ask in plain words; it answers and can do a few things on this PC.

First start: paste an Anthropic API key (kept in the GNOME keyring) and Orbit
installs the Claude library for this user. Then it is a chat: answers appear
as bubbles, and each action it takes (opening an app, switching dark mode …)
shows as a small line so you always see what it did.
"""
import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gio, GLib, Gtk, Pango  # noqa: E402

from . import assistant, ui  # noqa: E402

TOOL_TEXT = {"open_app": "Opening {name}", "open_website": "Opening {url}", "find_files": "Searching for “{text}”",
             "system_status": "Checking the system", "set_power_mode": "Power mode: {mode}",
             "set_dark_mode": "Changing dark mode", "start_focus": "Starting Focus for {minutes} min"}
EXAMPLES = ["How full is my disk?", "Open Steam", "Turn on dark mode", "Find my CV", "Focus for 50 minutes"]


class AssistantWindow(Adw.ApplicationWindow):
    def __init__(self, app):
        super().__init__(application=app, title="Assistant", default_width=640, default_height=760)
        self._toasts = Adw.ToastOverlay()
        self.chat = None
        hb = Adw.HeaderBar()
        new = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="New conversation", action_name="win.new")
        hb.pack_start(new)
        menu = Gio.Menu()
        menu.append("Change API Key…", "win.key")
        menu.append("Forget API Key", "win.forget")
        menu.append("About Orbit Assistant", "win.about")
        hb.pack_end(Gtk.MenuButton(icon_name="open-menu-symbolic", menu_model=menu))

        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.CROSSFADE)
        # setup page
        setup = Adw.StatusPage(icon_name="orbit-assistant", title="Orbit Assistant",
                               description="It uses Claude by Anthropic with your own API key. Get one at "
                                           "console.anthropic.com → API Keys; you pay Anthropic per use (a short "
                                           "question costs a fraction of a cent).")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, halign=Gtk.Align.CENTER, width_request=380)
        self.key_entry = Gtk.PasswordEntry(show_peek_icon=True, placeholder_text="sk-ant-…")
        self.key_entry.connect("activate", lambda *_: self.save_key())
        self.setup_btn = Gtk.Button(label="Start", css_classes=["pill", "suggested-action"])
        self.setup_btn.connect("clicked", lambda *_: self.save_key())
        self.setup_note = Gtk.Label(css_classes=["dim-label"], wrap=True, justify=Gtk.Justification.CENTER,
                                    label="The key stays in this PC’s keyring. Your questions go to Anthropic to be "
                                          "answered.")
        for w in (self.key_entry, self.setup_btn, self.setup_note):
            box.append(w)
        setup.set_child(box)
        self.stack.add_named(setup, "setup")

        # chat page
        self.msgs = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, margin_top=16, margin_bottom=16,
                            margin_start=16, margin_end=16)
        self.scroll = Gtk.ScrolledWindow(child=Adw.Clamp(child=self.msgs, maximum_size=720), vexpand=True)
        self.entry = Gtk.Entry(placeholder_text="Ask anything, or tell Orbit what to do…", hexpand=True)
        self.entry.connect("activate", lambda *_: self.send())
        self.send_btn = Gtk.Button(icon_name="go-up-symbolic", css_classes=["circular", "suggested-action"],
                                   tooltip_text="Send (Enter)")
        self.send_btn.connect("clicked", lambda *_: self.send())
        bar = Gtk.Box(spacing=8, margin_top=8, margin_bottom=12, margin_start=16, margin_end=16)
        bar.append(self.entry)
        bar.append(self.send_btn)
        chat = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        chat.append(self.scroll)
        chat.append(Adw.Clamp(child=bar, maximum_size=720))
        self.stack.add_named(chat, "chat")

        tv = Adw.ToolbarView(content=self.stack)
        tv.add_top_bar(hb)
        self._toasts.set_child(tv)
        self.set_content(self._toasts)
        for name, cb in {"new": self.new_chat, "key": lambda: self.stack.set_visible_child_name("setup"),
                         "forget": self.forget,
                         "about": lambda: ui.about(self, "Orbit Assistant", "orbit-assistant",
                                                   "Ask Orbit in plain words.")}.items():
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_a, cb=cb: cb())
            self.add_action(a)
        if assistant.get_key() and assistant.sdk_ready():
            self.start()
        else:
            self.stack.set_visible_child_name("setup")

    # ---- setup
    def save_key(self):
        key = self.key_entry.get_text().strip() or assistant.get_key() or ""
        if not assistant.key_looks_valid(key):
            ui.toast(self, "That doesn’t look like an Anthropic API key (it starts with sk-ant-)", 4)
            return
        self.setup_btn.set_sensitive(False)
        self.setup_note.set_label("Setting up (one-time download, about a minute)…")

        def work():
            assistant.set_key(key)
            if not assistant.sdk_ready():
                assistant.install_sdk()

        def done(_):
            self.key_entry.set_text("")
            self.setup_btn.set_sensitive(True)
            self.start()

        def fail(e):
            self.setup_btn.set_sensitive(True)
            self.setup_note.set_label(f"Setup failed: {e}. Check the internet connection and try again.")
        ui.run_async(work, done, fail)

    def forget(self):
        try:
            assistant.forget_key()
        except Exception:  # noqa: BLE001 - nothing stored
            pass
        self.chat = None
        self.stack.set_visible_child_name("setup")
        ui.toast(self, "API key removed from this PC", 2)

    def start(self):
        anthropic = assistant.load_sdk()
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=assistant.get_key())
        self.new_chat()
        self.stack.set_visible_child_name("chat")
        self.entry.grab_focus()

    # ---- chat
    def new_chat(self):
        if not getattr(self, "client", None):
            return
        self.chat = assistant.Chat(self.client)
        while (c := self.msgs.get_first_child()) is not None:
            self.msgs.remove(c)
        hello = self._bubble("Hi! Ask me anything, or tell me what to do on this PC.", mine=False)
        chips = Gtk.FlowBox(selection_mode=Gtk.SelectionMode.NONE, max_children_per_line=3, column_spacing=6,
                            row_spacing=6)
        for ex in EXAMPLES:
            b = Gtk.Button(label=ex, css_classes=["pill"])
            b.connect("clicked", lambda _b, t=ex: (self.entry.set_text(t), self.send()))
            chips.append(b)
        self.msgs.append(hello)
        self.msgs.append(chips)

    def _bubble(self, text, mine):
        lbl = Gtk.Label(label=text, wrap=True, wrap_mode=Pango.WrapMode.WORD_CHAR, xalign=0, selectable=True,
                        max_width_chars=60)
        frame = Gtk.Box(css_classes=["card"], halign=Gtk.Align.END if mine else Gtk.Align.START)
        lbl.set_margin_top(10)
        lbl.set_margin_bottom(10)
        lbl.set_margin_start(14)
        lbl.set_margin_end(14)
        frame.append(lbl)
        if mine:
            frame.add_css_class("accent")
        return frame

    def _note(self, text):
        lbl = Gtk.Label(label=text, css_classes=["dim-label", "caption"], xalign=0)
        self.msgs.append(lbl)
        return False

    def _scroll_end(self):
        adj = self.scroll.get_vadjustment()
        GLib.idle_add(lambda: (adj.set_value(adj.get_upper()), False)[1])

    def send(self):
        text = self.entry.get_text().strip()
        if not text or self.chat is None or not self.send_btn.get_sensitive():
            return
        self.entry.set_text("")
        self.msgs.append(self._bubble(text, mine=True))
        thinking = Gtk.Spinner(spinning=True, halign=Gtk.Align.START)
        self.msgs.append(thinking)
        self.send_btn.set_sensitive(False)
        self._scroll_end()

        def on_tool(name, args):
            try:
                line = TOOL_TEXT.get(name, name).format(**(args or {}))
            except (KeyError, IndexError):
                line = name
            GLib.idle_add(self._note, "→ " + line)

        def done(reply):
            self.msgs.remove(thinking)
            self.msgs.append(self._bubble(reply, mine=False))
            self.send_btn.set_sensitive(True)
            self._scroll_end()
            self.entry.grab_focus()

        def fail(e):
            a = self.anthropic
            if isinstance(e, a.AuthenticationError):
                msg = "Anthropic didn’t accept the API key. Menu → Change API Key."
            elif isinstance(e, a.PermissionDeniedError):
                msg = "This API key can’t use Claude yet (check billing at console.anthropic.com)."
            elif isinstance(e, a.RateLimitError):
                msg = "Too many questions at once. Wait a moment and try again."
            elif isinstance(e, a.APIConnectionError):
                msg = "No connection to Anthropic. Check the internet."
            elif isinstance(e, a.APIStatusError):
                msg = f"Anthropic had a problem ({e.status_code}). Try again in a moment."
            else:
                msg = f"Something went wrong: {e}"
            done(msg)
        ui.run_async(lambda: self.chat.send(text, on_tool), done, fail)


class AssistantApp(ui.OrbitApp):
    def __init__(self):
        super().__init__("org.orbit_os.Assistant", lambda app: AssistantWindow(app))


def main():
    return AssistantApp().run_main()
