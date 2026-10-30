"""Disk planning for the Orbit installer, checked against realistic disk layouts.

Run: python3 -m unittest tests/test_installer_plan.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "packages", "orbit-installer", "src"))
from orbit_installer import plan as P  # noqa: E402
from orbit_installer.target import Settings, validate  # noqa: E402

GiB, MiB = P.GiB, P.MiB


def empty(size=256 * GiB, path="/dev/nvme0n1"):
    return P.Disk(path=path, size=size, model="Test SSD", table="")


def windows_laptop(bitlocker=False, size=512 * GiB):
    """Typical Windows 11 laptop: ESP, MSR, C:, recovery at the end."""
    d = P.Disk(path="/dev/nvme0n1", size=size, model="Laptop SSD", table="gpt",
               first_usable=34 * 512, last_usable=size - 33 * 512)
    d.parts = [
        P.Part(1, 1 * MiB, 260 * MiB, "vfat", P.GPT_TYPE["esp"], "SYSTEM", "/dev/nvme0n1p1", esp_has_windows=True),
        P.Part(2, 261 * MiB, 16 * MiB, "", "E3C9E316-0B5C-4DB8-817D-F92DF00215AE", "", "/dev/nvme0n1p2"),
        P.Part(3, 277 * MiB, size - 277 * MiB - 1 * GiB - 2 * MiB, "bitlocker" if bitlocker else "ntfs",
               "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7", "Windows", "/dev/nvme0n1p3", windows=True, min_size=60 * GiB),
        P.Part(4, size - 1 * GiB - 1 * MiB, 1 * GiB, "ntfs", "DE94BBA4-06D1-4D40-A16A-BFD50179D6AC", "Recovery", "/dev/nvme0n1p4"),
    ]
    return d


def ends_inside(disk, plan):
    """Every partition the plan creates must lie inside the disk and not overlap an existing one it keeps."""
    sec = disk.sector
    first, last = disk.usable()
    made = []
    for s in plan.steps:
        if s.do == "new_table":
            pos = 0
            for p in s.args["parts"]:
                start = p["start"] * sec
                size = (p["size"] or (last - start) // sec) * sec
                made.append((start, start + size))
        if s.do == "add_part":
            made.append((s.args["start"] * sec, (s.args["start"] + s.args["size"]) * sec))
    kept = [] if plan.mode == "erase" else [(p.start, p.end) for p in disk.parts]
    for s in plan.steps:
        if s.do == "resize_part":
            kept = [(a, a + s.args["size"] * sec) if (a, b) == next(((p.start, p.end) for p in disk.parts if p.number == s.args["number"])) else (a, b)
                    for a, b in kept]
    for a, b in made:
        assert a >= first and b <= last, (a, b, first, last)
        assert a % MiB == 0, "partition start not 1 MiB aligned"
        for c, e in kept + [m for m in made if m != (a, b)]:
            assert b <= c or a >= e, f"overlap {(a, b)} with {(c, e)}"
    return made


class Erase(unittest.TestCase):
    def test_uefi_layout(self):
        d = empty()
        p = P.plan_erase(d, "uefi")
        table = next(s for s in p.steps if s.do == "new_table").args
        self.assertEqual(table["label"], "gpt")
        self.assertEqual([x["name"] for x in table["parts"]], ["EFI", "Orbit"])
        self.assertEqual(table["parts"][0]["size"] * 512, P.ESP_SIZE)
        self.assertEqual(p.esp, "/dev/nvme0n1p1")
        self.assertEqual(p.root, "/dev/nvme0n1p2")
        self.assertEqual(p.erases, ["/dev/nvme0n1"])
        self.assertEqual([s.do for s in p.steps], ["wipe", "new_table", "settle", "mkfs", "mkfs"])
        ends_inside(d, p)

    def test_bios_layout_has_bios_boot_partition(self):
        p = P.plan_erase(empty(path="/dev/sda"), "bios")
        names = [x["name"] for x in next(s for s in p.steps if s.do == "new_table").args["parts"]]
        self.assertEqual(names, ["BIOS boot", "Orbit"])
        self.assertEqual(p.root, "/dev/sda2")
        self.assertEqual(p.esp, "")

    def test_encrypted_layout(self):
        p = P.plan_erase(empty(), "uefi", encrypt=True)
        names = [x["name"] for x in next(s for s in p.steps if s.do == "new_table").args["parts"]]
        self.assertEqual(names, ["EFI", "Orbit boot", "Orbit"])
        self.assertTrue(p.encrypted)
        self.assertEqual(p.luks, "/dev/nvme0n1p3")
        self.assertEqual(p.root, "/dev/mapper/orbit-root")
        self.assertEqual(p.boot, "/dev/nvme0n1p2")
        self.assertIn("luks_format", [s.do for s in p.steps])

    def test_too_small(self):
        with self.assertRaises(P.PlanError):
            P.plan_erase(empty(size=16 * GiB), "uefi")

    def test_partition_paths(self):
        self.assertEqual(P.part_path("/dev/sda", 2), "/dev/sda2")
        self.assertEqual(P.part_path("/dev/nvme0n1", 2), "/dev/nvme0n1p2")
        self.assertEqual(P.part_path("/dev/mmcblk0", 1), "/dev/mmcblk0p1")
        self.assertEqual(P.part_path("/dev/loop7", 3), "/dev/loop7p3")


class Alongside(unittest.TestCase):
    def test_shrinks_windows_and_keeps_recovery(self):
        d = windows_laptop()
        win = d.parts[2]
        p = P.plan_alongside(d, "uefi", 3, 100 * GiB)
        shrink = next(s for s in p.steps if s.do == "ntfs_shrink").args
        self.assertEqual(shrink["device"], "/dev/nvme0n1p3")
        self.assertLessEqual(shrink["size"], win.size - 100 * GiB)
        self.assertEqual(p.esp, "/dev/nvme0n1p1", "reuses the Windows EFI partition")
        self.assertNotIn("/dev/nvme0n1p1", [s.args.get("device") for s in p.steps if s.do == "mkfs"], "never formats the Windows ESP")
        self.assertEqual(p.root, "/dev/nvme0n1p5")
        self.assertTrue(p.dual_boot)
        self.assertEqual(p.erases, [])
        made = ends_inside(d, p)
        self.assertLessEqual(made[-1][1], d.parts[3].start, "Orbit ends before the recovery partition")

    def test_respects_windows_minimum(self):
        d = windows_laptop(size=128 * GiB)
        with self.assertRaises(P.PlanError) as e:
            P.plan_alongside(d, "uefi", 3, 60 * GiB)
        self.assertIn("at most", str(e.exception))

    def test_bitlocker_is_refused_with_instructions(self):
        with self.assertRaises(P.PlanError) as e:
            P.plan_alongside(windows_laptop(bitlocker=True), "uefi", 3, 60 * GiB)
        self.assertIn("BitLocker", str(e.exception))

    def test_unknown_minimum_is_refused(self):
        d = windows_laptop()
        d.parts[2].min_size = 0
        with self.assertRaises(P.PlanError) as e:
            P.plan_alongside(d, "uefi", 3, 60 * GiB)
        self.assertIn("Fast Startup", str(e.exception))

    def test_encrypted_alongside(self):
        p = P.plan_alongside(windows_laptop(), "uefi", 3, 80 * GiB, encrypt=True)
        adds = [s.args for s in p.steps if s.do == "add_part"]
        self.assertEqual([a["name"] for a in adds], ["Orbit boot", "Orbit"])
        self.assertEqual([a["number"] for a in adds], [5, 6])
        self.assertEqual(p.luks, "/dev/nvme0n1p6")
        ends_inside(windows_laptop(), p)

    def test_options_offer_alongside(self):
        ids = {o["id"]: o for o in P.options(windows_laptop(), "uefi")}
        self.assertTrue(ids["erase"]["ok"])
        self.assertTrue(ids["alongside"]["ok"])
        ids = {o["id"]: o for o in P.options(windows_laptop(bitlocker=True), "uefi")}
        self.assertFalse(ids["alongside"]["ok"])


class FreeSpace(unittest.TestCase):
    def disk_with_gap(self, esp=True):
        d = P.Disk(path="/dev/sdb", size=500 * GiB, model="Data", table="gpt", first_usable=34 * 512, last_usable=500 * GiB - 33 * 512)
        d.parts = [P.Part(1, 1 * MiB, 200 * GiB, "ntfs", "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7", "Games", "/dev/sdb1")]
        if esp:
            d.parts.insert(0, P.Part(2, 200 * GiB + 1 * MiB, 512 * MiB, "vfat", P.GPT_TYPE["esp"], "EFI", "/dev/sdb2"))
        return d

    def test_uses_gap_and_existing_esp(self):
        d = self.disk_with_gap()
        g = P.gaps(d)[-1]
        p = P.plan_free_space(d, "uefi", g[0])
        self.assertEqual(p.esp, "/dev/sdb2")
        self.assertEqual(p.root, "/dev/sdb3")
        self.assertNotIn("wipe", [s.do for s in p.steps])
        ends_inside(d, p)

    def test_creates_esp_when_missing(self):
        d = self.disk_with_gap(esp=False)
        p = P.plan_free_space(d, "uefi", P.gaps(d)[-1][0])
        names = [s.args["name"] for s in p.steps if s.do == "add_part"]
        self.assertEqual(names, ["EFI", "Orbit"])
        ends_inside(d, p)

    def test_gap_too_small(self):
        d = self.disk_with_gap()
        d.size = d.last_usable = 210 * GiB
        gs = P.gaps(d)
        with self.assertRaises(P.PlanError):
            P.plan_free_space(d, "uefi", gs[-1][0] if gs else 0)

    def test_mbr_four_primaries_full(self):
        d = P.Disk(path="/dev/sda", size=500 * GiB, table="dos")
        d.parts = [P.Part(i, i * 10 * GiB, 5 * GiB, "ext4", "83") for i in range(1, 5)]
        with self.assertRaises(P.PlanError):
            P.next_number(d)


class Accounts(unittest.TestCase):
    def ok(self, **kw):
        base = dict(fullname="Sam", username="sam", password="secret1", hostname="sam-laptop", autologin=False,
                    locale="en_US.UTF-8", keyboard="us", variant="", timezone="Europe/Amsterdam")
        base.update(kw)
        return validate(Settings(**base))

    def test_valid(self):
        self.assertEqual(self.ok(), [])

    def test_bad_values(self):
        self.assertTrue(self.ok(username="Sam"))
        self.assertTrue(self.ok(username="root"))
        self.assertTrue(self.ok(password="123"))
        self.assertTrue(self.ok(hostname="-bad"))
        self.assertTrue(self.ok(timezone="../../etc/passwd"))
        self.assertTrue(self.ok(fullname="a:b"))
        self.assertTrue(self.ok(keyboard="us; rm -rf /"))


if __name__ == "__main__":
    unittest.main()
