#!/usr/bin/env python3
"""Builds scripts/hc_for_age_seed.json from the two WHO monthly head
circumference-for-age z-score tables (birth to 5 years; girls and boys).
Cut-offs are recomputed from the printed L, M, S to 3 decimals (the printed
ones are rounded to 1 decimal).

Usage: python3 scripts/build_hcfa_seed.py girls_0_5.xlsx boys_0_5.xlsx [out.json]
"""
import json, sys, openpyxl

SRC = "WHO Child Growth Standards: head circumference-for-age (cm), monthly z-score tables, birth to 5 years; cut-offs recomputed from the printed L, M, S to 3 decimals"
KEYS = ["sd_neg3", "sd_neg2", "sd_neg1", "median", "sd_pos1", "sd_pos2", "sd_pos3"]
ZS = [-3, -2, -1, 0, 1, 2, 3]

def build(sex, path):
    ws = openpyxl.load_workbook(path, data_only=True).active
    out = []
    for r in ws.iter_rows(values_only=True):
        if not isinstance(r[0], (int, float)):
            continue
        m, L, M, S = int(r[0]), r[1], r[2], r[3]
        printed = r[5:12]  # SD3neg .. SD3 (cols: Month L M S SD SD3neg SD2neg SD1neg SD0 SD1 SD2 SD3)
        calc = [M * (1 + L * S * z) ** (1 / L) for z in ZS]
        assert max(abs(c - p) for c, p in zip(calc, printed)) <= 0.051, (sex, m)
        out.append(dict(sex=sex, age_months=m, lms_l=L, lms_m=M, lms_s=S,
                        **{k: round(c, 3) for k, c in zip(KEYS, calc)}, source=SRC))
    return out

if __name__ == "__main__":
    girls, boys = sys.argv[1:3]
    dest = sys.argv[3] if len(sys.argv) > 3 else "scripts/hc_for_age_seed.json"
    items = build("girls", girls) + build("boys", boys)
    json.dump({"items": items}, open(dest, "w"), separators=(",", ":"))
    print(f"wrote {len(items)} rows to {dest}")
