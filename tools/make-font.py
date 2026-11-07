#!/usr/bin/env python3
"""Build "Saira HUD": Saira (SIL OFL 1.1, no Reserved Font Name) with tabular
digits frozen into the cmap, so HUD numbers do not jitter in After Effects
(which has no per-layer OpenType feature switch in its scripting API).

usage: python3 tools/make-font.py <dir with saira_{regular,medium,semibold,bold}.ttf> <out dir>
needs: fontTools (pip install fonttools)

Changes per weight: digits 0-9 map to the font's own `tnum` glyphs (zero.tf ...);
the family is renamed "Saira HUD" (OFL modified version, renamed to be safe);
version string notes the change. Nothing else is touched.
"""
import os, sys
from fontTools.ttLib import TTFont

WEIGHTS = [('regular', 'Regular', 400), ('medium', 'Medium', 500), ('semibold', 'SemiBold', 600), ('bold', 'Bold', 700)]
FAMILY = 'Saira HUD'
PS = 'SairaHUD'


def tnum_map(font):
    gsub = font['GSUB'].table
    out = {}
    for fr in gsub.FeatureList.FeatureRecord:
        if fr.FeatureTag != 'tnum':
            continue
        for li in fr.Feature.LookupListIndex:
            lk = gsub.LookupList.Lookup[li]
            for st in lk.SubTable:
                if hasattr(st, 'mapping'):
                    out.update(st.mapping)
    return out


def build(src, dst, style, weight):
    f = TTFont(src)
    m = tnum_map(f)
    if not m:
        raise SystemExit('no tnum lookup in ' + src)
    for table in f['cmap'].tables:
        if table.isUnicode():
            for cp, g in list(table.cmap.items()):
                if g in m:
                    table.cmap[cp] = m[g]
    name = f['name']
    ribbi = style in ('Regular', 'Bold')
    full = FAMILY + ('' if style == 'Regular' else ' ' + style)
    vals = {
        1: FAMILY if ribbi else FAMILY + ' ' + style,
        2: style if ribbi else 'Regular',
        3: '1.101;VOLTHUD;' + PS + '-' + style,
        4: full,
        5: 'Version 1.101; Saira with tabular digits (volt-hud)',
        6: PS + '-' + style,
        16: FAMILY,
        17: style,
    }
    for rec in list(name.names):
        if rec.nameID in (1, 2, 3, 4, 5, 6, 16, 17, 21, 22):
            name.removeNames(nameID=rec.nameID)
    for nid, v in vals.items():
        name.setName(v, nid, 3, 1, 0x409)
        name.setName(v, nid, 1, 0, 0)
    os2 = f['OS/2']
    os2.usWeightClass = weight
    # widths: every digit now has the tabular advance
    hm = f['hmtx']
    adv = set(hm[m[g]][0] for g in m)
    f.save(dst)
    return adv


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for key, style, weight in WEIGHTS:
        dst = os.path.join(out, PS + '-' + style + '.ttf')
        adv = build(os.path.join(src, 'saira_' + key + '.ttf'), dst, style, weight)
        print(dst, 'digit advances', sorted(adv))


if __name__ == '__main__':
    main()
