#!/usr/bin/env python3
"""Builds scripts/length_height_for_age_seed.json from the four WHO monthly
z-score tables (length-for-age 0-2 years, height-for-age 2-5 years, girls and
boys). Cut-offs are recomputed from the printed L, M, S to 3 decimals (the
printed ones are rounded to 1 decimal).

Usage: python3 scripts/build_lhfa_seed.py girls_0_2.xlsx girls_2_5.xlsx boys_0_2.xlsx boys_2_5.xlsx [out.json]
"""
import json, sys, openpyxl

SRC = "WHO Child Growth Standards: length/height-for-age (cm), monthly z-score tables, birth to 5 years; cut-offs recomputed from the printed L, M, S to 3 decimals"
ZS = [-3, -2, -1, 0, 1, 2, 3]
KEYS = ["sd_neg3", "sd_neg2", "sd_neg1", "median", "sd_pos1", "sd_pos2", "sd_pos3"]

def rows(path):
    ws = openpyxl.load_workbook(path, data_only=True).active
    return [r for r in ws.iter_rows(values_only=True) if isinstance(r[0], (int, float))]

def build(sex, path, measured):
    out = []
    for r in rows(path):
        m, L, M, S = int(r[0]), r[1], r[2], r[3]
        calc = [M * (1 + L * S * z) ** (1 / L) if L != 0 else M for z in ZS]
        printed = r[5:12]
        assert max(abs(c - p) for c, p in zip(calc, printed)) <= 0.051, (sex, measured, m)
        out.append(dict(sex=sex, age_months=m, measured=measured, lms_l=L, lms_m=M, lms_s=S,
                        **{k: round(c, 3) for k, c in zip(KEYS, calc)}, source=SRC))
    return out

if __name__ == "__main__":
    g02, g25, b02, b25 = sys.argv[1:5]
    dest = sys.argv[5] if len(sys.argv) > 5 else "scripts/length_height_for_age_seed.json"
    items = []
    for sex, a, b in (("girls", g02, g25), ("boys", b02, b25)):
        items += build(sex, a, "lying") + build(sex, b, "standing")
    json.dump({"items": items}, open(dest, "w"), separators=(",", ":"))
    print(f"wrote {len(items)} rows to {dest}")
