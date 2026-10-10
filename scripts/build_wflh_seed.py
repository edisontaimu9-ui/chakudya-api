#!/usr/bin/env python3
"""Builds the weight-for-length/height seed parts from the four WHO expanded
z-score tables (0.1 cm steps):
  weight-for-length  birth-2 years, lying,   45.0-110.0 cm
  weight-for-height  2-5 years,     standing, 65.0-120.0 cm
Output: scripts/weight_for_length_height_seed_1.json ... _N.json, at most 500
rows each (the bulk endpoint's cap). The printed 3-decimal cut-offs are used
after checking them against the stored L, M, S.

Usage: python3 scripts/build_wflh_seed.py wfl_girls.xlsx wfh_girls.xlsx wfl_boys.xlsx wfh_boys.xlsx [out_dir]
"""
import json, os, sys, openpyxl

KEYS = ["sd_neg3", "sd_neg2", "sd_neg1", "median", "sd_pos1", "sd_pos2", "sd_pos3"]
ZS = [-3, -2, -1, 0, 1, 2, 3]
SRC = {
    "lying": "WHO Child Growth Standards: weight-for-length (kg), birth to 2 years, expanded z-score tables",
    "standing": "WHO Child Growth Standards: weight-for-height (kg), 2 to 5 years, expanded z-score tables",
}

def build(sex, path, measured):
    ws = openpyxl.load_workbook(path, data_only=True).active
    out = []
    for r in ws.iter_rows(values_only=True):
        if not isinstance(r[0], (int, float)):
            continue
        x, L, M, S = round(float(r[0]), 1), r[1], r[2], r[3]
        printed = r[5:12]  # SD3neg .. SD3 (cols: Length L M S SD4neg SD3neg SD2neg SD1neg SD0 SD1 SD2 SD3 SD4)
        calc = [M * (1 + L * S * z) ** (1 / L) for z in ZS]
        assert max(abs(c - p) for c, p in zip(calc, printed)) <= 0.0011, (sex, measured, x)
        out.append(dict(sex=sex, measured=measured, length_height_cm=x, lms_l=L, lms_m=M, lms_s=S,
                        **{k: float(p) for k, p in zip(KEYS, printed)}, source=SRC[measured]))
    return out

if __name__ == "__main__":
    g_wfl, g_wfh, b_wfl, b_wfh = sys.argv[1:5]
    out_dir = sys.argv[5] if len(sys.argv) > 5 else "scripts"
    items = (build("girls", g_wfl, "lying") + build("girls", g_wfh, "standing")
             + build("boys", b_wfl, "lying") + build("boys", b_wfh, "standing"))
    parts = [items[i:i + 500] for i in range(0, len(items), 500)]
    for n, part in enumerate(parts, 1):
        json.dump({"items": part}, open(os.path.join(out_dir, f"weight_for_length_height_seed_{n}.json"), "w"), separators=(",", ":"))
    print(f"wrote {len(items)} rows in {len(parts)} files")
