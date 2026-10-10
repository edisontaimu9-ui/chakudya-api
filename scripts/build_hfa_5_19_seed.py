#!/usr/bin/env python3
"""Builds scripts/height_for_age_5_19_seed.json from the WHO 2007 growth
reference expanded z-score tables, height-for-age 5-19 years (girls, boys).
Rows go into the same table as the 0-5 year data (who_length_height_for_age),
measured = 'standing'. The printed cut-offs are already 3 decimals.

Usage: python3 scripts/build_hfa_5_19_seed.py hfa-girls-z-who-2007-exp.xlsx hfa-boys-z-who-2007-exp.xlsx [out.json]
"""
import json, sys, openpyxl

SRC = "WHO 2007 growth reference: height-for-age (cm), 5-19 years, expanded z-score tables"
KEYS = ["sd_neg3", "sd_neg2", "sd_neg1", "median", "sd_pos1", "sd_pos2", "sd_pos3"]
ZS = [-3, -2, -1, 0, 1, 2, 3]

def build(sex, path):
    ws = openpyxl.load_workbook(path, data_only=True).active
    out = []
    for r in ws.iter_rows(values_only=True):
        if not isinstance(r[0], (int, float)):
            continue
        m, L, M, S = int(r[0]), r[1], r[2], r[3]
        printed = r[7:14]  # SD3neg .. SD3 (cols: Month L M S StDev SD5neg SD4neg SD3neg SD2neg SD1neg SD0 SD1 SD2 SD3 SD4)
        calc = [M * (1 + L * S * z) for z in ZS]  # L = 1 throughout
        assert L == 1 and max(abs(c - p) for c, p in zip(calc, printed)) <= 0.0011, (sex, m)
        out.append(dict(sex=sex, age_months=m, measured="standing", lms_l=L, lms_m=M, lms_s=S,
                        **{k: float(p) for k, p in zip(KEYS, printed)}, source=SRC))
    return out

if __name__ == "__main__":
    girls, boys = sys.argv[1:3]
    dest = sys.argv[3] if len(sys.argv) > 3 else "scripts/height_for_age_5_19_seed.json"
    items = build("girls", girls) + build("boys", boys)
    json.dump({"items": items}, open(dest, "w"), separators=(",", ":"))
    print(f"wrote {len(items)} rows to {dest}")
