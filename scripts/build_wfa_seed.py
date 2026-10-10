#!/usr/bin/env python3
"""Builds scripts/weight_for_age_seed.json (months 0-120, both sexes) from:
  - WHO Child Growth Standards weight-for-age monthly z-score tables, 0-5 years
    (months 0-60); cut-offs recomputed from L, M, S to 3 decimals.
  - WHO 2007 growth reference weight-for-age 5-10 years, expanded tables
    (months 61-120); the printed 3-decimal cut-offs are used.

Usage: python3 scripts/build_wfa_seed.py girls_0_5.xlsx boys_0_5.xlsx girls_5_10.xlsx boys_5_10.xlsx [out.json]
"""
import json, sys, openpyxl

KEYS = ["sd_neg3", "sd_neg2", "sd_neg1", "median", "sd_pos1", "sd_pos2", "sd_pos3"]
ZS = [-3, -2, -1, 0, 1, 2, 3]
SRC_06 = "WHO Child Growth Standards: weight-for-age (kg), monthly z-score tables, birth to 5 years; cut-offs recomputed from the printed L, M, S to 3 decimals"
SRC_07 = "WHO 2007 growth reference: weight-for-age (kg), 5-10 years, expanded z-score tables"

def data_rows(path):
    ws = openpyxl.load_workbook(path, data_only=True).active
    return [r for r in ws.iter_rows(values_only=True) if isinstance(r[0], (int, float))]

def lms_cut(L, M, S):
    return [M * (1 + L * S * z) ** (1 / L) if L != 0 else M * 2.718281828459045 ** (S * z) for z in ZS]

def build_0_5(sex, path):
    out = []
    for r in data_rows(path):
        m, L, M, S = int(r[0]), r[1], r[2], r[3]
        calc = lms_cut(L, M, S)
        assert max(abs(c - p) for c, p in zip(calc, r[4:11])) <= 0.051, (sex, m)
        out.append(dict(sex=sex, age_months=m, lms_l=L, lms_m=M, lms_s=S,
                        **{k: round(c, 3) for k, c in zip(KEYS, calc)}, source=SRC_06))
    return out

def build_5_10(sex, path):
    out = []
    for r in data_rows(path):
        m, L, M, S = int(r[0]), r[1], r[2], r[3]
        printed = r[5:12]  # SD3neg .. SD3 (cols: Month L M S SD4neg SD3neg SD2neg SD1neg SD0 SD1 SD2 SD3 SD4)
        calc = lms_cut(L, M, S)
        assert max(abs(c - p) for c, p in zip(calc, printed)) <= 0.0011, (sex, m)
        out.append(dict(sex=sex, age_months=m, lms_l=L, lms_m=M, lms_s=S,
                        **{k: float(p) for k, p in zip(KEYS, printed)}, source=SRC_07))
    return out

if __name__ == "__main__":
    g05, b05, g510, b510 = sys.argv[1:5]
    dest = sys.argv[5] if len(sys.argv) > 5 else "scripts/weight_for_age_seed.json"
    items = build_0_5("girls", g05) + build_5_10("girls", g510) + build_0_5("boys", b05) + build_5_10("boys", b510)
    json.dump({"items": items}, open(dest, "w"), separators=(",", ":"))
    print(f"wrote {len(items)} rows to {dest}")
