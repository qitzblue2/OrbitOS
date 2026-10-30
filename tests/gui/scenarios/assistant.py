import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import harness  # noqa: E402
from orbit import assistant, assistant_app  # noqa: E402

# no keyring or network in the screenshot run: a fake key store and a fake Claude
assistant.get_key = lambda: None
assistant.sdk_ready = lambda: False


class FakeChat:
    def __init__(self, client):
        self.history = []

    def send(self, text, on_tool=lambda n, a: None):
        on_tool("set_dark_mode", {"on": True})
        return "Done: dark mode is on."


def wait(w):
    pass


def chat(w):
    assistant.Chat = FakeChat
    w.client, w.anthropic = object(), None
    w.new_chat()
    w.stack.set_visible_child_name("chat")
    w.entry.set_text("Turn on dark mode")
    w.send()


errs = harness.run(assistant_app.AssistantApp(), [(None, wait), (None, wait), ("assistant-setup", wait),
                                                  (None, chat), ("assistant-chat", wait)],
                   sys.argv[1], settle_ms=1200)
print("\n".join(errs))
print("SCENARIO OK" if not errs else "SCENARIO FAILED")
