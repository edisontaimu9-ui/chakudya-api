#!/usr/bin/env python3
"""Builds scripts/bmi_for_age_under5_seed.json from the four WHO monthly BMI-for-age
z-score tables (birth to 2 years, 2 to 5 years; girls and boys). Month 24 is in both
tables (lying and standing). Cut-offs are recomputed from the printed L, M, S to
3 decimals (the printed ones are rounded to 1 decimal).

Usage: python3 scripts/build_bmi_under5_seed.py girls_0_2.xlsx girls_2_5.xlsx boys_0_2.xlsx boys_2_5.xlsx [out.json]
"""
import json, sys, openpyxl

SRC = "WHO Child Growth Standards: BMI-for-age (kg/m2), monthly z-score tables, birth to 5 years; cut-offs recomputed from the printed L, M, S to 3 decimals"
KEYS = ["sd_neg3", "sd_neg2", "sd_neg1", "median", "sd_pos1", "sd_pos2", "sd_pos3"]
ZS = [-3, -2, -1, 0, 1, 2, 3]

def build(sex, path, measured):
    ws = openpyxl.load_workbook(path, data_only=True).active
    out = []
    for r in ws.iter_rows(values_only=True):
        if not isinstance(r[0], (int, float)):
            continue
        m, L, M, S = int(r[0]), r[1], r[2], r[3]
        calc = [M * (1 + L * S * z) ** (1 / L) for z in ZS]
        assert max(abs(c - p) for c, p in zip(calc, r[4:11])) <= 0.051, (sex, measured, m)
        out.append(dict(sex=sex, age_months=m, measured=measured, lms_l=L, lms_m=M, lms_s=S,
                        **{k: round(c, 3) for k, c in zip(KEYS, calc)}, source=SRC))
    return out

if __name__ == "__main__":
    g02, g25, b02, b25 = sys.argv[1:5]
    dest = sys.argv[5] if len(sys.argv) > 5 else "scripts/bmi_for_age_under5_seed.json"
    items = []
    for sex, a, b in (("girls", g02, g25), ("boys", b02, b25)):
        items += build(sex, a, "lying") + build(sex, b, "standing")
    json.dump({"items": items}, open(dest, "w"), separators=(",", ":"))
    print(f"wrote {len(items)} rows to {dest}")
