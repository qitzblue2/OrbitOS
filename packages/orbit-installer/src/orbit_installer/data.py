"""Languages, keyboard layouts and time zones offered by the installer (read from the live system where possible)."""
import os
import xml.etree.ElementTree as ET

# (locale, native name, English name, default keyboard, default time zone)
LANGUAGES = [
    ("en_US.UTF-8", "English (US)", "English (US)", "us", "America/New_York"),
    ("en_GB.UTF-8", "English (UK)", "English (UK)", "gb", "Europe/London"),
    ("nl_NL.UTF-8", "Nederlands", "Dutch", "us", "Europe/Amsterdam"),
    ("nl_BE.UTF-8", "Nederlands (België)", "Dutch (Belgium)", "be", "Europe/Brussels"),
    ("de_DE.UTF-8", "Deutsch", "German", "de", "Europe/Berlin"),
    ("fr_FR.UTF-8", "Français", "French", "fr", "Europe/Paris"),
    ("es_ES.UTF-8", "Español", "Spanish", "es", "Europe/Madrid"),
    ("es_MX.UTF-8", "Español (México)", "Spanish (Mexico)", "latam", "America/Mexico_City"),
    ("it_IT.UTF-8", "Italiano", "Italian", "it", "Europe/Rome"),
    ("pt_PT.UTF-8", "Português", "Portuguese", "pt", "Europe/Lisbon"),
    ("pt_BR.UTF-8", "Português (Brasil)", "Portuguese (Brazil)", "br", "America/Sao_Paulo"),
    ("pl_PL.UTF-8", "Polski", "Polish", "pl", "Europe/Warsaw"),
    ("cs_CZ.UTF-8", "Čeština", "Czech", "cz", "Europe/Prague"),
    ("sv_SE.UTF-8", "Svenska", "Swedish", "se", "Europe/Stockholm"),
    ("da_DK.UTF-8", "Dansk", "Danish", "dk", "Europe/Copenhagen"),
    ("nb_NO.UTF-8", "Norsk bokmål", "Norwegian", "no", "Europe/Oslo"),
    ("fi_FI.UTF-8", "Suomi", "Finnish", "fi", "Europe/Helsinki"),
    ("tr_TR.UTF-8", "Türkçe", "Turkish", "tr", "Europe/Istanbul"),
    ("el_GR.UTF-8", "Ελληνικά", "Greek", "gr", "Europe/Athens"),
    ("ru_RU.UTF-8", "Русский", "Russian", "ru", "Europe/Moscow"),
    ("uk_UA.UTF-8", "Українська", "Ukrainian", "ua", "Europe/Kyiv"),
    ("ar_EG.UTF-8", "العربية", "Arabic", "ara", "Africa/Cairo"),
    ("hi_IN.UTF-8", "हिन्दी", "Hindi", "in", "Asia/Kolkata"),
    ("id_ID.UTF-8", "Bahasa Indonesia", "Indonesian", "us", "Asia/Jakarta"),
    ("vi_VN.UTF-8", "Tiếng Việt", "Vietnamese", "vn", "Asia/Ho_Chi_Minh"),
    ("th_TH.UTF-8", "ไทย", "Thai", "th", "Asia/Bangkok"),
    ("zh_CN.UTF-8", "简体中文", "Chinese (Simplified)", "cn", "Asia/Shanghai"),
    ("zh_TW.UTF-8", "繁體中文", "Chinese (Traditional)", "tw", "Asia/Taipei"),
    ("ja_JP.UTF-8", "日本語", "Japanese", "jp", "Asia/Tokyo"),
    ("ko_KR.UTF-8", "한국어", "Korean", "kr", "Asia/Seoul"),
]

FALLBACK_LAYOUTS = [("us", "", "English (US)"), ("gb", "", "English (UK)"), ("us", "intl", "English (US, intl., with dead keys)"),
                    ("de", "", "German"), ("fr", "", "French"), ("be", "", "Belgian"), ("es", "", "Spanish"),
                    ("it", "", "Italian"), ("pt", "", "Portuguese"), ("br", "", "Portuguese (Brazil)")]


def layouts(path="/usr/share/X11/xkb/rules/evdev.xml"):
    """[(layout, variant, description)] from the XKB rules, layouts first then their variants."""
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError):
        return FALLBACK_LAYOUTS
    out = []
    for lay in root.iter("layout"):
        ci = lay.find("configItem")
        name, desc = ci.findtext("name"), ci.findtext("description")
        out.append((name, "", desc))
        for var in lay.iter("variant"):
            vci = var.find("configItem")
            out.append((name, vci.findtext("name"), vci.findtext("description")))
    return out


def timezones(path="/usr/share/zoneinfo/zone1970.tab"):
    """Sorted list of time zone names such as Europe/Amsterdam."""
    zones = set()
    try:
        with open(path) as f:
            for line in f:
                if line.startswith("#") or not line.strip():
                    continue
                zones.add(line.split("\t")[2].strip())
    except OSError:
        zones = {lang[4] for lang in LANGUAGES} | {"UTC"}
    zones.add("UTC")
    return sorted(z for z in zones if os.path.sep not in z.replace("/", "") )


def nice_zone(z):
    parts = z.split("/")
    return f"{parts[-1].replace('_', ' ')} · {parts[0]}" if len(parts) > 1 else z
